import Foundation
import WebKit

public enum WebKitRuntimeError: Error, LocalizedError {
  case failed(String)
  public var errorDescription: String? {
    switch self {
    case .failed(let message): message
    }
  }
}

/// Only this transport touches WebKit. The public SDK is Sendable and has no
/// main-actor requirement. Neither the WKWebView nor its message bridge escapes.
@available(macOS 14.0, iOS 27.0, *)
@MainActor
final class WebKitTransport: NSObject, WKNavigationDelegate {
  private var webView: WKWebView?
  private var bridge: MessageBridge?
  private var server: LoopbackServer?
  private let networking = NativeNetwork()
  private var mounts: [Int: (NativeFileSystem, Bool)] = [:]
  private var nextMount = 0
  private let cacheDirectory: URL
  private var origin: URL?
  private var ready: CheckedContinuation<Void, Error>?
  private var readyTimeout: Task<Void, Never>?
  private var closed = false
  private var pending: [String: CheckedContinuation<Data, Error>] = [:]

  init(cacheDirectory: URL) {
    self.cacheDirectory = cacheDirectory
    super.init()
  }
  var isWebViewAttached: Bool { webView?.superview != nil || webView?.window != nil }
  var nativeNetworkStats: NativeNetworkStats { get async { await networking.statistics() } }
  var nativeOperationCount: Int {
    get async {
      var count = 0
      for (fs, _) in mounts.values { count += await fs.operations }
      return count
    }
  }

  func registerMount(directory: URL, readOnly: Bool) throws -> Int {
    guard !closed else {
      throw SdkError.Failure(code: "CLIENT_CLOSED", message: "Client is closed")
    }
    let fs = try NativeFileSystem(directory: directory)
    nextMount += 1
    mounts[nextMount] = (fs, readOnly)
    return nextMount
  }
  func removeMounts(_ ids: [Int]) async {
    for id in ids { if let (fs, _) = mounts.removeValue(forKey: id) { await fs.shutdown() } }
  }

  func start() async throws {
    guard let assets = Bundle.module.url(forResource: "Web", withExtension: nil),
      FileManager.default.fileExists(
        atPath: assets.appendingPathComponent("sdk/pkg/wasmer_sdk_js_bg.wasm").path)
    else {
      throw SdkError.Failure(
        code: "INITIALIZATION_ERROR",
        message: "WasmerSDK runtime resources are missing from the app bundle")
    }
    let server = LoopbackServer(directory: assets, cacheDirectory: cacheDirectory)
    self.server = server
    let url = try await server.start()
    origin = url
    let configuration = WKWebViewConfiguration()
    configuration.preferences.inactiveSchedulingPolicy = .none
    configuration.websiteDataStore = .nonPersistent()
    let bridge = MessageBridge(owner: self)
    self.bridge = bridge
    configuration.userContentController.addScriptMessageHandler(
      bridge, contentWorld: .page, name: "wasmer")
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.isHidden = true
    view.navigationDelegate = self
    webView = view
    try await withTaskCancellationHandler {
      try Task.checkCancellation()
      try await withCheckedThrowingContinuation { continuation in
        ready = continuation
        readyTimeout = Task { [weak self] in
          do { try await Task.sleep(for: .seconds(30)) } catch { return }
          await self?.close(
            error: SdkError.Failure(
              code: "INITIALIZATION_ERROR", message: "WebKit startup timed out"))
        }
        view.load(URLRequest(url: url))
      }
    } onCancel: {
      Task { @MainActor [weak self] in await self?.close(error: CancellationError()) }
    }
  }

  func request(_ method: String, payload: Data) async throws -> Data {
    try Task.checkCancellation()
    guard let view = webView, !closed else {
      throw SdkError.Failure(code: "CLIENT_CLOSED", message: "Client is closed")
    }
    let id = UUID().uuidString
    // JSON data crosses actors; untyped Foundation objects remain on this actor.
    let args = try JSONSerialization.jsonObject(with: payload, options: [.fragmentsAllowed])
    let command = try JSONSerialization.data(withJSONObject: [
      "id": id, "method": method, "args": args,
    ])
    let json = String(decoding: command, as: UTF8.self)
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        pending[id] = continuation
        Task { @MainActor [weak self] in
          do {
            let value = try await view.callAsyncJavaScript(
              "return JSON.stringify(await globalThis.wasmerRPC.request(JSON.parse(payload)));",
              arguments: ["payload": json], in: nil, contentWorld: .page)
            guard let reply = value as? String else {
              throw SdkError.Failure(code: "INTERNAL_ERROR", message: "Invalid WebKit reply")
            }
            self?.pending.removeValue(forKey: id)?.resume(returning: Data(reply.utf8))
          } catch {
            self?.pending.removeValue(forKey: id)?.resume(
              throwing: SdkError.Failure(
                code: "EXECUTION_ERROR", message: error.localizedDescription))
          }
        }
      }
    } onCancel: {
      Task { @MainActor [weak self] in self?.cancel(id) }
    }
  }

  private func cancel(_ id: String) {
    pending.removeValue(forKey: id)?.resume(throwing: CancellationError())
    guard let view = webView else { return }
    Task { @MainActor in
      _ = try? await view.callAsyncJavaScript(
        "globalThis.wasmerRPC.cancel(id)", arguments: ["id": id], in: nil, contentWorld: .page)
    }
  }
  func close(error: Error = SdkError.Failure(code: "CLIENT_CLOSED", message: "Client is closed"))
    async
  {
    guard !closed else { return }
    closed = true
    readyTimeout?.cancel()
    readyTimeout = nil
    ready?.resume(throwing: error)
    ready = nil
    let completions = Array(pending.values)
    pending.removeAll()
    for completion in completions { completion.resume(throwing: error) }
    // Native cleanup must not wait for an unresponsive WebContent process.
    if let view = webView {
      Task { @MainActor in _ = try? await view.evaluateJavaScript("globalThis.wasmerRPC?.stop()") }
    }
    webView?.stopLoading()
    webView?.configuration.userContentController.removeScriptMessageHandler(forName: "wasmer")
    webView?.navigationDelegate = nil
    webView = nil
    bridge = nil
    server?.stop()
    server = nil
    await removeMounts(Array(mounts.keys))
    await networking.shutdown()
  }

  fileprivate func receive(
    _ message: WKScriptMessage, reply: @escaping @MainActor @Sendable (Any?, String?) -> Void
  ) {
    guard !closed, message.frameInfo.isMainFrame,
      message.frameInfo.securityOrigin.protocol == origin?.scheme,
      message.frameInfo.securityOrigin.host == origin?.host,
      message.frameInfo.securityOrigin.port == origin?.port,
      var body = message.body as? [String: Any], let kind = body["kind"] as? String
    else {
      reply(nil, "Invalid runtime message")
      return
    }
    switch kind {
    case "ready":
      guard body["pageIsolated"] as? Bool == true, body["workerIsolated"] as? Bool == true,
        body["sharedArrayBuffer"] as? Bool == true, body["jspi"] as? Bool == true
      else {
        reply(true, nil)
        let reason = body["jspiError"] as? String ?? "iOS 27 JSPI and isolated workers are required"
        Task {
          await close(error: SdkError.Failure(code: "CAPABILITY_UNAVAILABLE", message: reason))
        }
        return
      }
      readyTimeout?.cancel()
      readyTimeout = nil
      ready?.resume()
      ready = nil
      reply(true, nil)
    case "network", "filesystem":
      do {
        let filesystem: NativeFileSystem?
        if kind == "filesystem" {
          guard let mount = body["mount"] as? Int, let (fs, readOnly) = mounts[mount] else {
            reply(nil, "Mount is closed")
            return
          }
          filesystem = fs
          body["mount"] = readOnly ? 2 : 1
        } else {
          filesystem = nil
        }
        let data = try JSONSerialization.data(withJSONObject: body)
        Task {
          let response =
            if let filesystem { await filesystem.dispatch(data) } else {
              await networking.dispatch(data)
            }
          reply(try? JSONSerialization.jsonObject(with: response), nil)
        }
      } catch { reply(nil, error.localizedDescription) }
    case "fatal":
      let reason = body["message"] as? String ?? "Worker failed"
      reply(true, nil)
      Task { await close(error: SdkError.Failure(code: "WORKER_FAILED", message: reason)) }
    case "progress": reply(true, nil)
    default: reply(nil, "Unknown runtime message")
    }
  }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    Task {
      await close(
        error: SdkError.Failure(code: "WORKER_FAILED", message: "WebKit content process terminated")
      )
    }
  }
  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) { Task { await close(error: error) } }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    Task { await close(error: error) }
  }
  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
  ) {
    decisionHandler(action.request.url == origin ? .allow : .cancel)
  }
}

@available(macOS 14.0, iOS 27.0, *)
@MainActor
private final class MessageBridge: NSObject, WKScriptMessageHandlerWithReply {
  weak var owner: WebKitTransport?
  init(owner: WebKitTransport) { self.owner = owner }
  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
    replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
  ) {
    guard let owner else {
      replyHandler(nil, "Runtime released")
      return
    }
    owner.receive(message, reply: replyHandler)
  }
}
