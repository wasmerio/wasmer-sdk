import SwiftUI
import WebKit

@MainActor final class Probe: NSObject, ObservableObject, WKScriptMessageHandler {
  @Published var status = "Starting unattached WKWebView memory probe"
  private var webView: WKWebView?

  func start() {
    guard webView == nil else { return }
    guard let index = CommandLine.arguments.firstIndex(of: "--url"),
      CommandLine.arguments.indices.contains(index + 1),
      let url = URL(string: CommandLine.arguments[index + 1]) else {
      status = "Missing --url argument"
      return
    }
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.userContentController.add(self, name: "probe")
    let webView = WKWebView(frame: .zero, configuration: config)
    self.webView = webView
    webView.load(URLRequest(url: url))
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard var result = message.body as? [String: Any] else { return }
    result["webViewAttached"] = webView?.window != nil
    result["osVersion"] = ProcessInfo.processInfo.operatingSystemVersionString
    guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) else { return }
    status = String(decoding: data, as: UTF8.self)
    let name = result["kind"] as? String == "result" ? "result.json" : "progress.json"
    try? data.write(to: URL.documentsDirectory.appendingPathComponent(name), options: .atomic)
  }
}

@main struct MemoryProbe: App {
  @StateObject private var probe = Probe()
  var body: some Scene {
    WindowGroup { ScrollView { Text(probe.status).monospaced() }.task { probe.start() } }
  }
}
