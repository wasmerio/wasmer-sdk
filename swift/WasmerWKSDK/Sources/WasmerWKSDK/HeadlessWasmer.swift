import Foundation
import WebKit

public struct CommandOutput: Sendable, Codable {
  public let exitCode: Int
  public let stdout: String
  public let stderr: String
  public let reason: String
}

public struct WebKitCapabilities: Sendable, Codable {
  public let pageIsolated: Bool
  public let workerIsolated: Bool
  public let sharedArrayBuffer: Bool
  /// True only after a Wasm import actually suspends and resumes in the worker.
  public let jspi: Bool
  public let jspiError: String?
  public let webViewAttached: Bool
}

public enum WebKitRuntimeError: Error, LocalizedError {
  case failed(String)
  public var errorDescription: String? {
    switch self { case .failed(let message): message }
  }
}

/// Experimental foreground runtime. The WKWebView is owned privately and is
/// never attached to a view hierarchy, presented, or handed to application UI.
@available(macOS 14.0, iOS 27.0, *)
@MainActor
public final class HeadlessWasmer: NSObject, WKNavigationDelegate {
  private var webView: WKWebView?
  private var bridge: MessageBridge?
  private var server: LoopbackServer?
  private let filesystem: NativeFileSystem
  private let networking = NativeNetwork()
  private var origin: URL?
  private var ready: CheckedContinuation<WebKitCapabilities, Error>?
  private var readyTimeout: Task<Void, Never>?
  private var started = false
  private var closed = false
  private var capabilities: WebKitCapabilities?
  private var terminalActive = false
  private var pending: [UUID: CheckedContinuation<String, Error>] = [:]
  public var onProgress: ((String) -> Void)?
  public var onTerminalOutput: ((Data) -> Void)?
  public var onTerminalExit: ((CommandOutput) -> Void)?
  public var onListeningPortsChanged: (([UInt16]) -> Void)?

  public init(directory: URL) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    filesystem = try NativeFileSystem(directory: directory)
    super.init()
  }

  public var isWebViewAttached: Bool { webView?.superview != nil || webView?.window != nil }
  public var nativeOperationCount: Int { get async { await filesystem.operations } }
  public var nativeNetworkStats: NativeNetworkStats { get async { await networking.statistics() } }

  public func start() async throws -> WebKitCapabilities {
    guard !started, !closed else { throw WebKitRuntimeError.failed("Runtime was already started or closed") }
    started = true
    #if SWIFT_PACKAGE
    let bundle = Bundle.module
    #else
    let bundle = Bundle.main
    #endif
    guard let assets = bundle.url(forResource: "Web", withExtension: nil),
      FileManager.default.fileExists(atPath: assets.appendingPathComponent("sdk/pkg/wasmer_sdk_js_bg.wasm").path) else {
      throw WebKitRuntimeError.failed("WasmerWKSDK resources are missing. Link the WasmerWKSDK Swift package product so its resource bundle is embedded in the app.")
    }
    let server = LoopbackServer(directory: assets)
    self.server = server
    let url = try await server.start()
    origin = url
    let configuration = WKWebViewConfiguration()
    configuration.preferences.inactiveSchedulingPolicy = .none
    configuration.websiteDataStore = .nonPersistent()
    let bridge = MessageBridge(owner: self)
    self.bridge = bridge
    configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "wasmer")
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.isHidden = true
    view.navigationDelegate = self
    webView = view
    return try await withCheckedThrowingContinuation { continuation in
      ready = continuation
      readyTimeout = Task { [weak self] in
        do { try await Task.sleep(for: .seconds(30)) } catch { return }
        self?.fail(WebKitRuntimeError.failed("Hidden WebView worker startup timed out"))
      }
      view.load(URLRequest(url: url))
    }
  }

  public func runCowsay(_ message: String) async throws -> CommandOutput {
    try await request(["method": "runCowsay", "message": message])
  }

  /// Run Python source with sys.argv[1...] supplied by arguments. Requires JSPI.
  public func runPython(_ source: String, arguments: [String] = []) async throws -> CommandOutput {
    guard capabilities?.jspi == true else {
      throw WebKitRuntimeError.failed(capabilities?.jspiError ?? "Start the runtime and verify JSPI before running Python (iOS 27+)")
    }
    return try await request(["method": "runPython", "source": source, "arguments": arguments])
  }

  public func startTerminal(columns: Int = 80, rows: Int = 24) async throws {
    guard capabilities?.jspi == true else { throw WebKitRuntimeError.failed("Terminal requires JSPI (iOS 27+)") }
    terminalActive = true
    do { let _: Bool = try await request(["method": "startTerminal", "columns": columns, "rows": rows]) }
    catch { terminalActive = false; throw error }
  }

  public func writeTerminal(_ bytes: Data) async throws {
    for offset in stride(from: 0, to: bytes.count, by: 16 * 1024) {
      let chunk = bytes.subdata(in: offset..<min(offset + 16 * 1024, bytes.count))
      let _: Bool = try await request(["method": "writeTerminal", "base64": chunk.base64EncodedString()])
    }
  }

  public func resizeTerminal(columns: Int, rows: Int) async throws {
    let _: Bool = try await request(["method": "resizeTerminal", "columns": columns, "rows": rows])
  }

  public func stopTerminal() async throws {
    let _: Bool = try await request(["method": "stopTerminal"])
  }

  /// Forward HTTP into the terminal sandbox's in-memory networking stack.
  /// Cancelling or timing out this request does not terminate the shell.
  public func handleHTTPRequest(port: UInt16, request http: GuestHTTPRequest) async throws -> GuestHTTPResponse {
    let requestObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(http))
    return try await request(["method": "httpRequest", "port": Int(port), "request": requestObject],
      timeoutSeconds: 30, cancelClosesRuntime: false)
  }

  private func request<T: Decodable>(_ command: [String: Any], timeoutSeconds: Int = 300, cancelClosesRuntime: Bool = true) async throws -> T {
    let json = try await requestJSON(command, timeoutSeconds: timeoutSeconds, cancelClosesRuntime: cancelClosesRuntime)
    return try JSONDecoder().decode(T.self, from: Data(json.utf8))
  }

  private func requestJSON(_ command: [String: Any], timeoutSeconds: Int, cancelClosesRuntime: Bool) async throws -> String {
    try Task.checkCancellation()
    guard let view = webView, capabilities != nil, !closed else { throw WebKitRuntimeError.failed("Runtime is not ready") }
    let id = UUID()
    let timeout = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(timeoutSeconds)) } catch { return }
      guard let self, self.pending[id] != nil else { return }
      let reason = "Runtime operation exceeded \(timeoutSeconds) seconds"
      if cancelClosesRuntime { await self.close(reason: reason) }
      else { self.pending.removeValue(forKey: id)?.resume(throwing: WebKitRuntimeError.failed(reason)) }
    }
    defer { timeout.cancel() }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        pending[id] = continuation
        Task { @MainActor [weak self] in
          do {
            let value = try await view.callAsyncJavaScript(
              "return JSON.stringify(await globalThis.wasmerPrototype.request(command));",
              arguments: ["command": command], in: nil, contentWorld: .page
            )
            guard let json = value as? String else { throw WebKitRuntimeError.failed("Invalid runtime response") }
            self?.pending.removeValue(forKey: id)?.resume(returning: json)
          } catch {
            let details = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String
            self?.pending.removeValue(forKey: id)?.resume(throwing: details.map(WebKitRuntimeError.failed) ?? error)
          }
        }
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        if cancelClosesRuntime { await self?.close(reason: "Swift task cancelled") }
        else { self?.pending.removeValue(forKey: id)?.resume(throwing: CancellationError()) }
      }
    }
  }

  /// Closing, or cancelling a command operation, destroys this prototype runtime
  /// and releases native descriptors. HTTP cancellation only abandons its reply.
  /// Create another HeadlessWasmer to restart against the same files.
  public func close() async { await close(reason: "Runtime closed") }

  private func close(reason: String) async {
    guard !closed else { return }
    closed = true
    fail(WebKitRuntimeError.failed(reason))
    // Fire and forget on teardown: a terminated WebContent process must not
    // delay native cleanup while we wait for JavaScript to acknowledge it.
    if let view = webView {
      Task { @MainActor in _ = try? await view.evaluateJavaScript("globalThis.wasmerPrototype?.stop()") }
    }
    webView?.stopLoading()
    webView?.configuration.userContentController.removeScriptMessageHandler(forName: "wasmer")
    webView?.navigationDelegate = nil
    webView = nil
    bridge = nil
    server?.stop()
    server = nil
    await filesystem.shutdown()
    await networking.shutdown()
  }

  private func fail(_ error: Error) {
    onListeningPortsChanged?([])
    if terminalActive {
      terminalActive = false
      onTerminalExit?(CommandOutput(exitCode: 1, stdout: "", stderr: error.localizedDescription, reason: "failed"))
    }
    readyTimeout?.cancel()
    readyTimeout = nil
    ready?.resume(throwing: error)
    ready = nil
    let completions = Array(pending.values)
    pending.removeAll()
    for completion in completions { completion.resume(throwing: error) }
  }

  fileprivate func receive(_ message: WKScriptMessage, reply: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
    guard !closed, message.frameInfo.isMainFrame,
      message.frameInfo.securityOrigin.host == origin?.host,
      message.frameInfo.securityOrigin.port == origin?.port,
      let body = message.body as? [String: Any], let kind = body["kind"] as? String
    else { reply(nil, "Invalid runtime message"); return }
    switch kind {
    case "ready":
      let capabilities = WebKitCapabilities(
        pageIsolated: body["pageIsolated"] as? Bool == true,
        workerIsolated: body["workerIsolated"] as? Bool == true,
        sharedArrayBuffer: body["sharedArrayBuffer"] as? Bool == true,
        jspi: body["jspi"] as? Bool == true,
        jspiError: body["jspiError"] as? String,
        webViewAttached: isWebViewAttached
      )
      self.capabilities = capabilities
      readyTimeout?.cancel()
      readyTimeout = nil
      ready?.resume(returning: capabilities)
      ready = nil
      reply(true, nil)
    case "network", "filesystem":
      do {
        let data = try JSONSerialization.data(withJSONObject: body)
        Task {
          let response = kind == "network" ? await networking.dispatch(data) : await filesystem.dispatch(data)
          reply(try? JSONSerialization.jsonObject(with: response), nil)
        }
      } catch { reply(nil, error.localizedDescription) }
    case "progress":
      onProgress?(body["message"] as? String ?? "")
      reply(true, nil)
    case "terminalOutput":
      guard let base64 = body["base64"] as? String, let bytes = Data(base64Encoded: base64) else {
        reply(nil, "Invalid terminal bytes"); return
      }
      onTerminalOutput?(bytes)
      reply(true, nil)
    case "listeningPorts":
      guard let ports = body["ports"] as? [Int], ports.allSatisfy({ (1...65535).contains($0) }) else {
        reply(nil, "Invalid listening ports"); return
      }
      onListeningPortsChanged?(ports.map { UInt16($0) })
      reply(true, nil)
    case "terminalExit":
      do {
        let data = try JSONSerialization.data(withJSONObject: body["result"] as Any)
        let result = try JSONDecoder().decode(CommandOutput.self, from: data)
        terminalActive = false
        onListeningPortsChanged?([])
        onTerminalExit?(result)
        reply(true, nil)
      } catch { reply(nil, error.localizedDescription) }
    case "fatal":
      fail(WebKitRuntimeError.failed(body["message"] as? String ?? "Worker failed"))
      reply(true, nil)
    default: reply(nil, "Unknown runtime message")
    }
  }

  public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    Task { await close(reason: "WebKit content process terminated") }
  }

  public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }
  public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }

  public func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
    decisionHandler(action.request.url == origin ? .allow : .cancel)
  }
}

@available(macOS 14.0, iOS 27.0, *)
@MainActor
private final class MessageBridge: NSObject, WKScriptMessageHandlerWithReply {
  weak var owner: HeadlessWasmer?
  init(owner: HeadlessWasmer) { self.owner = owner }
  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
    guard let owner else { replyHandler(nil, "Runtime released"); return }
    owner.receive(message, reply: replyHandler)
  }
}
