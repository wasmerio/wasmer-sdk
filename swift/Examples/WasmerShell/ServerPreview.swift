import WasmerWKSDK
import SwiftUI
import WebKit

/// Visible guest browser. It deliberately has no native message handlers and
/// uses its own data store and loopback origin, separate from the runtime.
@MainActor
final class ServerPreview: NSObject, ObservableObject, Identifiable, WKNavigationDelegate {
  let id = UUID()
  let port: UInt16
  let webView: WKWebView
  private let server: GuestHTTPServer
  private let bootstrapURL: URL
  @Published var title = "Loading server…"
  @Published var error: String?

  init(port: UInt16, server: GuestHTTPServer, url: URL) {
    self.port = port; self.server = server; bootstrapURL = url
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    webView = WKWebView(frame: .zero, configuration: configuration)
    super.init()
    webView.navigationDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    webView.load(URLRequest(url: url))
  }

  func reload() { error = nil; webView.reload() }
  func close() { webView.stopLoading(); webView.navigationDelegate = nil; server.stop() }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    title = webView.title ?? "Local server"
    error = nil
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    showNavigationError(error)
  }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    showNavigationError(error)
  }
  private func showNavigationError(_ error: Error) {
    let failure = error as NSError
    // Redirects and superseded loads can cancel a navigation after the page loads.
    guard failure.domain != NSURLErrorDomain || failure.code != NSURLErrorCancelled else { return }
    self.error = error.localizedDescription
  }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    error = "The preview stopped. Reload to reconnect to the server."
  }
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url, url.scheme == bootstrapURL.scheme,
      url.host == bootstrapURL.host, url.port == bootstrapURL.port else {
      decisionHandler(.cancel); return
    }
    decisionHandler(.allow)
  }
}

struct ServerPreviewSheet: View {
  @ObservedObject var preview: ServerPreview
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        if let error = preview.error {
          Text(error).font(.callout).foregroundStyle(.red).padding()
        }
        GuestBrowser(webView: preview.webView).id(preview.id)
      }
      .navigationTitle("localhost:\(String(preview.port))")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Terminal", systemImage: "terminal") { dismiss() }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Reload", systemImage: "arrow.clockwise") { preview.reload() }
        }
      }
    }
  }
}

private struct GuestBrowser: UIViewRepresentable {
  let webView: WKWebView
  func makeUIView(context: Context) -> WKWebView { webView }
  func updateUIView(_ uiView: WKWebView, context: Context) {}
}
