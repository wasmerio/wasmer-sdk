import WasmerSDK
import SwiftUI
import WebKit

/// Visible guest browser. It deliberately has no native message handlers and
/// uses its own data store and loopback origin, separate from the runtime.
@MainActor
final class ServerPreview: NSObject, ObservableObject, Identifiable, WKNavigationDelegate {
  let id = UUID()
  let port: UInt16
  let webView: WKWebView
  private let server: ExposedPort
  private let bootstrapURL: URL
  private let rootURL: URL
  private var observations: [NSKeyValueObservation] = []
  @Published private(set) var title = "Loading server…"
  @Published private(set) var address: String
  @Published private(set) var canGoBack = false
  @Published private(set) var canGoForward = false
  @Published private(set) var isLoading = true
  @Published var error: String?

  init(port: UInt16, server: ExposedPort, url: URL) {
    self.port = port; self.server = server; bootstrapURL = url
    rootURL = URL(string: "/", relativeTo: url)!.absoluteURL
    address = "localhost:\(port)"
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    webView = WKWebView(frame: .zero, configuration: configuration)
    super.init()
    webView.navigationDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    observe(\.url); observe(\.title); observe(\.canGoBack)
    observe(\.canGoForward); observe(\.isLoading)
    webView.load(URLRequest(url: url))
  }

  private func observe<Value>(_ keyPath: KeyPath<WKWebView, Value>) {
    observations.append(webView.observe(keyPath, options: [.new]) { [weak self] _, _ in
      Task { @MainActor [weak self] in self?.updateNavigationState() }
    })
  }

  private func updateNavigationState() {
    canGoBack = webView.canGoBack
    canGoForward = webView.canGoForward
    isLoading = webView.isLoading
    title = webView.title.flatMap { $0.isEmpty ? nil : $0 } ?? "localhost:\(port)"
    // The initial URL installs the preview cookie. Keep that capability and the
    // native proxy's ephemeral port out of the address bar.
    if let url = webView.url, url != bootstrapURL,
       let components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
      let path = components.percentEncodedPath == "/" ? "" : components.percentEncodedPath
      let query = components.percentEncodedQuery.map { "?" + $0 } ?? ""
      let fragment = components.percentEncodedFragment.map { "#" + $0 } ?? ""
      address = "localhost:\(port)\(path)\(query)\(fragment)"
    }
  }

  @discardableResult
  func navigate(to address: String) -> Bool {
    let value = address.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else { return false }
    let hasLocalHost = value.lowercased().hasPrefix("localhost:") || value.hasPrefix("127.0.0.1:")
    guard let url = URL(string: hasLocalHost ? "http://" + value : value, relativeTo: rootURL)?.absoluteURL,
          var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          components.user == nil, components.password == nil else {
      error = "Enter a server address or a path such as /docs."
      return false
    }
    if url.scheme == "http", ["localhost", "127.0.0.1"].contains(url.host?.lowercased() ?? ""), url.port == Int(port) {
      components.host = rootURL.host
      components.port = rootURL.port
    }
    guard let destination = components.url, isServerURL(destination) else {
      error = "Use an address on localhost:\(port)."
      return false
    }
    error = nil
    webView.load(URLRequest(url: destination))
    return true
  }

  func goBack() { error = nil; webView.goBack() }
  func goForward() { error = nil; webView.goForward() }
  func reload() { error = nil; webView.reload() }
  func stop() { webView.stopLoading() }
  func close() {
    observations.removeAll()
    webView.stopLoading(); webView.navigationDelegate = nil; server.close()
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    updateNavigationState()
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
  private func isServerURL(_ url: URL) -> Bool {
    url.scheme == bootstrapURL.scheme && url.host == bootstrapURL.host && url.port == bootstrapURL.port
  }
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url, isServerURL(url) else {
      decisionHandler(.cancel); return
    }
    decisionHandler(.allow)
  }
}

struct ServerPreviewSheet: View {
  @ObservedObject var preview: ServerPreview
  @Environment(\.dismiss) private var dismiss
  @State private var address = ""
  @FocusState private var editingAddress: Bool

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        HStack(spacing: 4) {
          Button("Back", systemImage: "chevron.left") { editingAddress = false; preview.goBack() }
            .disabled(!preview.canGoBack)
            .frame(minWidth: 44, minHeight: 44)
          Button("Forward", systemImage: "chevron.right") { editingAddress = false; preview.goForward() }
            .disabled(!preview.canGoForward)
            .frame(minWidth: 44, minHeight: 44)
          TextField("Server address", text: $address)
            .font(.subheadline)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.go)
            .focused($editingAddress)
            .padding(.horizontal, 12).frame(minHeight: 44)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
            .accessibilityLabel("Server address")
            .onSubmit {
              if preview.navigate(to: address) { editingAddress = false }
            }
        }
        .labelStyle(.iconOnly)
        .padding(.horizontal, 12).padding(.bottom, 8)
        Divider()
        if let error = preview.error {
          Text(error).font(.callout).foregroundStyle(.red).padding()
        }
        GuestBrowser(webView: preview.webView).id(preview.id)
      }
      .navigationTitle(preview.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Terminal", systemImage: "terminal") { dismiss() }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button(preview.isLoading ? "Stop loading" : "Reload", systemImage: preview.isLoading ? "xmark" : "arrow.clockwise") {
            editingAddress = false
            if preview.isLoading { preview.stop() } else { preview.reload() }
          }
        }
      }
      .onAppear { address = preview.address }
      .onChange(of: preview.address) { _, value in
        if !editingAddress { address = value }
      }
      .onChange(of: editingAddress) { _, editing in
        if !editing { address = preview.address }
      }
    }
  }
}

private struct GuestBrowser: UIViewRepresentable {
  let webView: WKWebView
  func makeUIView(context: Context) -> WKWebView { webView }
  func updateUIView(_ uiView: WKWebView, context: Context) {}
}
