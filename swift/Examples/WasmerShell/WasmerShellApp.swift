import WasmerSDK
import Foundation
import SwiftUI

@main
struct WasmerShellApp: App {
  @StateObject private var session = TerminalSession()
  var body: some Scene {
    WindowGroup {
      VStack(spacing: 0) {
        HStack(spacing: 2) {
          VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 3) {
              Image("wasmer-logo").resizable().renderingMode(.original).scaledToFit()
                .frame(width: 100, height: 20)
              Text(".iOS").font(.system(size: 14, weight: .semibold, design: .monospaced))
                .tracking(-1).foregroundStyle(ShellTheme.muted)
            }.fixedSize().accessibilityElement(children: .ignore).accessibilityLabel("Wasmer.iOS")
            if !session.starting {
              Text(session.status).font(.caption).foregroundStyle(ShellTheme.muted).lineLimit(1)
            }
          }.frame(minWidth: 134, alignment: .leading)
          Spacer(minLength: 4)
          Menu {
            ForEach(ShellStorage.allCases, id: \.self) { value in
              Button { Task { await session.selectStorage(value) } } label: {
                if value == session.storage { Label(value.label, systemImage: "checkmark") }
                else { Text(value.label) }
              }
            }
            Text("Changing storage restarts the shell. Memory is cleared on restart.")
          } label: { Image(systemName: "externaldrive") }
            .accessibilityLabel("Storage: " + session.storage.label).disabled(session.starting)

          Button {
            session.view.resignFirstResponder()
            session.showingExamples = true
          } label: { Image(systemName: "square.grid.2x2") }
            .buttonStyle(ShellButtonStyle(isSelected: session.showingExamples))
            .accessibilityLabel("Examples").disabled(session.starting)
          if !session.previews.isEmpty {
            Menu {
              ForEach(session.previews) { preview in
                Button("localhost:\(String(preview.port))") { session.present(preview) }
              }
            } label: { Image(systemName: "globe") }.accessibilityLabel("Open server")
          }
          Button { _ = session.view.isFirstResponder ? session.view.resignFirstResponder() : session.view.becomeFirstResponder() } label: {
            Image(systemName: "keyboard")
          }.accessibilityLabel("Toggle keyboard").disabled(session.showingExamples || !session.ready)
          Button { Task { await session.restart() } } label: { Image(systemName: "arrow.clockwise") }
            .accessibilityLabel("Restart terminal").disabled(session.starting || session.showingExamples)
        }.buttonStyle(ShellButtonStyle()).padding(.horizontal, 12).padding(.vertical, 12)
        Divider()
        if session.showingExamples {
          ExamplePicker(session: session)
        } else {
          ZStack {
            NativeTerminal(view: session.view).frame(maxWidth: .infinity, maxHeight: .infinity)
              .accessibilityHidden(session.starting || session.loading.error != nil)
            if session.starting || session.loading.error != nil {
              ShellLoadingView(state: session.loading) {
                Task { await session.restart() }
              }
            }
          }
          if !session.starting && session.loading.error == nil {
            Divider()
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 8) {
                key("Esc", 7); key("Tab", 6)
                Button("Ctrl-C") { session.view.sendControl(3) }
                Button("Ctrl-D") { session.view.sendControl(4) }
                key("↑", 0); key("↓", 1); key("←", 2); key("→", 3)
              }.font(.system(.callout, design: .monospaced))
                .buttonStyle(ShellButtonStyle(isSelected: true)).padding(10)
            }.disabled(!session.ready)
          }
        }
      }
      .foregroundStyle(ShellTheme.text)
      .tint(ShellTheme.muted)
      .background(ShellTheme.page)
      .preferredColorScheme(.dark)
      .task { await session.startIfRequested() }
      .sheet(item: $session.presentedPreview) { preview in ServerPreviewSheet(preview: preview).id(preview.id) }
    }
  }
  private func key(_ title: String, _ code: Int32) -> some View {
    Button(title) { session.view.sendKey(code) }
  }
}

@MainActor
final class TerminalSession: ObservableObject {
  let view = TerminalView(frame: .zero)
  @Published var storage = ShellStorage.initial
  @Published var showingExamples = true
  @Published var selectedExample: ShellExample?
  @Published var loading = ShellLoadingState()
  @Published var status = "Choose an example" {
    didSet {
      #if WASMER_SHELL_TESTS
      reportTestProgress()
      #endif
    }
  }
  @Published var ready = false
  @Published var starting = false
  @Published var previews: [ServerPreview] = []
  @Published var presentedPreview: ServerPreview?
  private var listeningPorts: Set<UInt16> = []
  private(set) var openingPorts: Set<UInt16> = []
  private var previewGeneration = 0
  private(set) var runtime: ShellRuntime?
  private(set) var inputTask: Task<Void, Never>?
  private var resizeGeneration = 0
  private(set) var transcript = Data()
  private(set) var exit: Output?
  #if WASMER_SHELL_TESTS
  var integrationTestsStarted = false
  #endif
  let directory = URL.documentsDirectory.appendingPathComponent("WasmerTerminal")

  func startIfRequested() async {
    let arguments = ProcessInfo.processInfo.arguments
    // CLI and integration entry points keep opening directly into the terminal.
    guard arguments.contains("--smoke-test") || arguments.contains("--stress-test") ||
          arguments.contains(where: { $0.hasPrefix("--example-") }) else { return }
    showingExamples = false
    let focusedTemplateTest = ["node-richards", "clang"].contains { arguments.contains("--example-" + $0) }
    if focusedTemplateTest || (!arguments.contains("--smoke-test") && !arguments.contains("--stress-test")) {
      selectedExample = ShellExample.all.first { arguments.contains("--example-" + $0.id) }
    }
    await start()
  }

  func chooseExample(_ example: ShellExample?) async {
    guard !starting else { return }
    if ready, selectedExample?.id == example?.id {
      showingExamples = false
      return
    }
    selectedExample = example
    showingExamples = false
    await restart()
  }

  func start() async {
    guard runtime == nil, !starting else { return }
    starting = true
    defer { starting = false }
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let host = try ShellRuntime(directory: directory, storage: storage, example: selectedExample)
      runtime = host
      transcript.removeAll(); exit = nil
      loading = ShellLoadingState(names: host.packageNames)
      host.onPackageProgress = { [weak self] progress in self?.loading.update(progress) }
      host.onPackagesLoaded = { [weak self] ids in self?.loading.complete(ids) }
      host.onProgress = { [weak self] message in
        self?.status = message
      }
      host.onTerminalOutput = { [weak self] bytes in
        guard let self else { return }
        self.transcript.append(bytes)
        if self.transcript.count > 1024 * 1024 { self.transcript.removeFirst(self.transcript.count - 1024 * 1024) }
        self.view.feed(bytes)
      }
      host.onTerminalExit = { [weak self] result in
        guard let self else { return }
        self.exit = result; self.ready = false
        self.status = "Session exited · \(result.exitCode)"
        self.view.feed(Data("\r\n\u{1b}[90m[Session exited. Tap restart to begin again.]\u{1b}[0m\r\n".utf8))
      }
      host.onTerminalFailure = { [weak self, weak host] error in
        guard let self, let host, self.runtime === host else { return }
        self.ready = false
        self.status = error.localizedDescription
        self.view.feed(Data("\r\n[Session stopped: \(error.localizedDescription). Tap restart to begin again.]\r\n".utf8))
      }
      host.onListeningPortsChanged = { [weak self, weak host] ports in
        guard let self, let host, self.runtime === host else { return }
        self.updatePorts(ports, host: host)
      }
      view.onInput = { [weak self] bytes in self?.send(bytes) }
      view.onResize = { [weak self, weak host] columns, rows in
        guard let self, self.ready else { return }
        self.resizeGeneration += 1
        let generation = self.resizeGeneration
        Task { [weak self, weak host] in
          do {
            try await Task.sleep(for: .milliseconds(100))
            guard let self, self.resizeGeneration == generation, let host, self.runtime === host, self.ready else { return }
            try await host.resizeTerminal(columns: columns, rows: rows)
          } catch is CancellationError {} catch { self?.status = error.localizedDescription }
        }
      }
      try await host.start()
      if let example = selectedExample {
        try await host.seedExamples(example.id, at: "/workspace")
      } else {
        try await host.seedExamples()
      }
      if selectedExample == nil, !(try await host.fs.readDir()).contains(where: { $0.name == "demo.py" }) {
        try await host.fs.writeText("demo.py", "name = input('What is your name? '); print(f'Hello, {name}!')\n")
      }
      guard !host.isWebViewAttached else { throw DemoError.failed("Runtime WebView was attached") }
      var welcome = "\u{1b}[2J\u{1b}[H\u{1b}[38;5;245mWelcome to wasmer.iOS\u{1b}[0m\r\n"
      welcome += "Run any Wasmer package on iOS with the Wasmer SDK for Swift.\r\n"
      if let example = selectedExample {
        welcome += "\(example.title) · \(example.description)\r\n"
        if let install = example.install { welcome += "Install:  \(install)\r\n" }
        welcome += "Run:      \(example.run)\r\n"
      } else {
        welcome += "Type \u{1b}[38;5;81mls\u{1b}[0m to explore the workspace.\r\n"
      }
      view.feed(Data((welcome + "\r\n").utf8))
      status = "Starting Bash…"
      try await host.startTerminal(columns: view.columns, rows: view.rows)
      ready = true; status = "\(storage.label) · \(selectedExample?.title ?? "Bash · Node.js · Python")"
      #if WASMER_SHELL_TESTS
      if startIntegrationTests(host) { return }
      #endif
      if let name = ["node", "node-next", "node-richards", "clang", "python"].first(where: { ProcessInfo.processInfo.arguments.contains("--example-" + $0) }) {
        Task {
          do { try await waitFor("➜ ~ $ "); runExample(name) }
          catch { status = error.localizedDescription }
        }
      }
    } catch {
      loading.error = error.localizedDescription
      status = error.localizedDescription
      view.feed(Data("\r\nError: \(error.localizedDescription)\r\n".utf8))
      #if WASMER_SHELL_TESTS
      if smoke || stress { writeReport(["passed": false, "error": error.localizedDescription]) }
      #endif
      await runtime?.close(); runtime = nil
    }
  }

  func selectStorage(_ value: ShellStorage) async {
    guard value != storage, !starting else { return }
    storage = value
    UserDefaults.standard.set(value.rawValue, forKey: "shellStorage")
    if runtime != nil { await restart() }
  }

  func send(_ bytes: Data) {
    guard ready, let host = runtime else { return }
    // Keep keystrokes and pasted chunks ordered even when bridge calls suspend.
    let previous = inputTask
    inputTask = Task { [weak self] in
      await previous?.value
      guard let self, self.runtime === host, self.ready else { return }
      do { try await host.writeTerminal(bytes) }
      catch { if self.runtime === host, self.ready { self.status = error.localizedDescription } }
    }
  }
  func restart() async {
    guard !starting else { return }
    starting = true
    closePreviews()
    ready = false; resizeGeneration += 1
    runtime?.onTerminalExit = nil
    runtime?.onTerminalFailure = nil
    runtime?.onTerminalOutput = nil
    runtime?.onProgress = nil
    runtime?.onPackageProgress = nil
    runtime?.onPackagesLoaded = nil
    loading = ShellLoadingState()
    await runtime?.close(); runtime = nil
    await inputTask?.value; inputTask = nil
    starting = false
    await start()
  }

  func runExample(_ name: String) {
    guard let example = ShellExample.all.first(where: { $0.id == name }) else { return }
    view.resignFirstResponder()
    let workingDirectory = selectedExample == nil ? "/workspace/" + example.id : "/workspace"
    send(Data(("cd " + workingDirectory + " && " + example.run + "\r").utf8))
  }

  func present(_ preview: ServerPreview) {
    view.resignFirstResponder()
    presentedPreview = preview
  }

  private func updatePorts(_ ports: [UInt16], host: ShellRuntime) {
    listeningPorts = Set(ports)
    for preview in previews where !listeningPorts.contains(preview.port) {
      if presentedPreview?.id == preview.id { presentedPreview = nil }
      preview.close()
    }
    previews.removeAll { !listeningPorts.contains($0.port) }
    // Limit the demo's native listeners and browser processes.
    for port in ports.prefix(4) where !previews.contains(where: { $0.port == port }) && !openingPorts.contains(port) {
      openingPorts.insert(port)
      let generation = previewGeneration
      Task { [weak self, weak host] in
        guard let self, let host else { return }
        defer { if self.previewGeneration == generation { self.openingPorts.remove(port) } }
        do {
          let server = try await host.expose(port)
          guard self.runtime === host, self.previewGeneration == generation, self.listeningPorts.contains(port) else {
            server.close(); return
          }
          let preview = ServerPreview(port: port, server: server, url: server.url)
          self.previews.append(preview)
          self.present(preview)
        } catch { self.status = error.localizedDescription }
      }
    }
  }

  private func closePreviews() {
    previewGeneration += 1
    presentedPreview = nil
    for preview in previews { preview.close() }
    previews.removeAll(); listeningPorts.removeAll(); openingPorts.removeAll()
  }

  var text: String {
    String(decoding: transcript, as: UTF8.self)
      .replacingOccurrences(of: "\r", with: "")
      .replacingOccurrences(of: "\u{1b}(?:\\[[0-?]*[ -/]*[@-~]|[=>])", with: "", options: .regularExpression)
  }
  func waitFor(_ marker: String, after offset: Int = 0, timeout: Int = 45, failureMarker: String? = nil) async throws {
    let deadline = ContinuousClock.now + .seconds(timeout)
    while !String(text.dropFirst(offset)).contains(marker) {
      if let failureMarker, String(text.dropFirst(offset)).contains(failureMarker) {
        throw DemoError.failed("Command exited before \(marker)")
      }
      if let exit { throw DemoError.failed("Session exited early: \(exit.exitCode)") }
      guard ready else { throw DemoError.failed("Session unavailable: \(status)") }
      guard ContinuousClock.now < deadline else { throw DemoError.failed("Timed out waiting for \(marker)") }
      try await Task.sleep(for: .milliseconds(50))
    }
  }
}
