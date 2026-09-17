import Foundation
import SwiftUI

@main
struct WasmerTerminalApp: App {
  @StateObject private var session = TerminalSession()
  var body: some Scene {
    WindowGroup {
      VStack(spacing: 0) {
        HStack(spacing: 12) {
          Image(systemName: "terminal.fill").font(.title2).foregroundStyle(.mint)
          VStack(alignment: .leading, spacing: 3) {
            Text("Wasmer Terminal").font(.headline)
            Text(session.status).font(.caption).foregroundStyle(.secondary).lineLimit(1)
          }
          Spacer()
          Menu {
            Section("Run at the Bash prompt") {
              Button("Node.js server") { session.runExample("node") }
              Button("Python server") { session.runExample("python") }
            }
            if !session.previews.isEmpty {
              Section("Open server") {
                ForEach(session.previews) { preview in
                  Button("localhost:\(String(preview.port))") { session.present(preview) }
                }
              }
            }
          } label: { Image(systemName: "globe") }
            .accessibilityLabel("Examples and servers").disabled(!session.ready)
          Button { _ = session.view.isFirstResponder ? session.view.resignFirstResponder() : session.view.becomeFirstResponder() } label: {
            Image(systemName: "keyboard")
          }.accessibilityLabel("Toggle keyboard")
          Button { Task { await session.restart() } } label: { Image(systemName: "arrow.clockwise") }
            .accessibilityLabel("Restart terminal").disabled(session.starting)
        }.padding(16)
        Divider()
        NativeTerminal(view: session.view).frame(maxWidth: .infinity, maxHeight: .infinity)
        Divider()
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            key("Esc", 7); key("Tab", 6)
            Button("Ctrl-C") { session.view.sendControl(3) }
            Button("Ctrl-D") { session.view.sendControl(4) }
            key("↑", 0); key("↓", 1); key("←", 2); key("→", 3)
          }.font(.system(.callout, design: .monospaced)).buttonStyle(.bordered).tint(.mint).padding(10)
        }.disabled(!session.ready)
      }
      .background(Color(red: 0.051, green: 0.078, blue: 0.071))
      .preferredColorScheme(.dark)
      .task { await session.start() }
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
  @Published var status = "Starting…"
  @Published var ready = false
  @Published var starting = false
  @Published var previews: [ServerPreview] = []
  @Published var presentedPreview: ServerPreview?
  private var listeningPorts: Set<UInt16> = []
  private var openingPorts: Set<UInt16> = []
  private var previewGeneration = 0
  private var runtime: HeadlessWasmer?
  private var inputTask: Task<Void, Never>?
  private var resizeGeneration = 0
  private var transcript = Data()
  private var exit: CommandOutput?
  private let smoke = ProcessInfo.processInfo.arguments.contains("--smoke-test")
  private let directory = URL.documentsDirectory.appendingPathComponent("WasmerTerminal")

  func start() async {
    guard runtime == nil, !starting else { return }
    starting = true
    defer { starting = false }
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try seedExamples()
      let demo = directory.appendingPathComponent("demo.py")
      if !FileManager.default.fileExists(atPath: demo.path) {
        try Data("""
        from pathlib import Path
        name = input("What is your name? ")
        print(f"Hello, {name}! Python is running on your iPhone.")
        Path("hello.txt").write_text(f"Hello, {name}!\\n")
        print("Saved hello.txt in the native Documents directory.")
        """.utf8).write(to: demo)
      }
      let host = try HeadlessWasmer(directory: directory)
      runtime = host
      transcript.removeAll(); exit = nil
      host.onProgress = { [weak self] message in
        self?.status = message
        if self?.smoke == true {
          try? Data(message.utf8).write(to: URL.documentsDirectory.appendingPathComponent("terminal-progress.txt"), options: .atomic)
        }
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
      let capabilities = try await host.start()
      guard capabilities.jspi, !capabilities.webViewAttached else { throw WebKitRuntimeError.failed("iOS 27 JSPI is required") }
      view.feed(Data("\u{1b}[2J\u{1b}[H\u{1b}[1;32mLocal programs. Native terminal.\u{1b}[0m\r\nTry python, node, or cowsay hello.\r\nRun node node/server.js to open a browser.\r\nExamples are in /native/node and /native/python.\r\n\r\n".utf8))
      try await host.startTerminal(columns: view.columns, rows: view.rows)
      ready = true; status = "Bash · Node.js · Python"
      if smoke { Task { await runSmokeTest(host) } }
      else if let name = ["node", "python"].first(where: { ProcessInfo.processInfo.arguments.contains("--example-" + $0) }) {
        Task {
          do { try await waitFor("wasmer:"); runExample(name) }
          catch { status = error.localizedDescription }
        }
      }
    } catch {
      status = error.localizedDescription
      view.feed(Data("\r\nError: \(error.localizedDescription)\r\n".utf8))
      if smoke { writeReport(["passed": false, "error": error.localizedDescription]) }
      await runtime?.close(); runtime = nil
    }
  }

  private func seedExamples() throws {
    // Seed only missing files so scripts edited in the terminal survive restarts.
    let examples = Bundle.main.resourceURL!.appendingPathComponent("Examples")
    if let files = FileManager.default.enumerator(at: examples, includingPropertiesForKeys: [.isRegularFileKey]) {
      for case let source as URL in files {
        guard try source.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else { continue }
        let relative = String(source.path.dropFirst(examples.path.count + 1))
        let destination = directory.appendingPathComponent(relative)
        if !FileManager.default.fileExists(atPath: destination.path) {
          try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
          try FileManager.default.copyItem(at: source, to: destination)
        }
      }
    }
  }

  func send(_ bytes: Data) {
    guard ready, let host = runtime else { return }
    // Keep keystrokes and pasted chunks ordered even when bridge calls suspend.
    let previous = inputTask
    inputTask = Task { [weak self] in
      await previous?.value
      do { try await host.writeTerminal(bytes) }
      catch { self?.status = error.localizedDescription }
    }
  }
  func restart() async {
    closePreviews()
    ready = false; resizeGeneration += 1
    runtime?.onTerminalExit = nil
    runtime?.onTerminalOutput = nil
    await runtime?.close(); runtime = nil
    await inputTask?.value; inputTask = nil
    await start()
  }

  func runExample(_ name: String) {
    view.resignFirstResponder()
    let command = name == "node" ? "node /native/node/server.js" : "python /native/python/server.py"
    send(Data((command + "\r").utf8))
  }

  func present(_ preview: ServerPreview) {
    view.resignFirstResponder()
    presentedPreview = preview
  }

  private func updatePorts(_ ports: [UInt16], host: HeadlessWasmer) {
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
        let server = GuestHTTPServer { [weak host] request in
          guard let host else { throw WebKitRuntimeError.failed("Runtime closed") }
          return try await host.handleHTTPRequest(port: port, request: request)
        }
        do {
          let url = try await server.start()
          guard self.runtime === host, self.previewGeneration == generation, self.listeningPorts.contains(port) else {
            server.stop(); return
          }
          let preview = ServerPreview(port: port, server: server, url: url)
          self.previews.append(preview)
          self.present(preview)
        } catch { server.stop(); self.status = error.localizedDescription }
      }
    }
  }

  private func closePreviews() {
    previewGeneration += 1
    presentedPreview = nil
    for preview in previews { preview.close() }
    previews.removeAll(); listeningPorts.removeAll(); openingPorts.removeAll()
  }

  private var text: String {
    String(decoding: transcript, as: UTF8.self)
      .replacingOccurrences(of: "\r", with: "")
      .replacingOccurrences(of: "\u{1b}(?:\\[[0-?]*[ -/]*[@-~]|[=>])", with: "", options: .regularExpression)
  }
  private func waitFor(_ marker: String, after offset: Int = 0, timeout: Int = 45) async throws {
    let deadline = ContinuousClock.now + .seconds(timeout)
    while !String(text.dropFirst(offset)).contains(marker) {
      if let exit { throw WebKitRuntimeError.failed("Session exited early: \(exit.exitCode)") }
      guard ContinuousClock.now < deadline else { throw WebKitRuntimeError.failed("Timed out waiting for \(marker)") }
      try await Task.sleep(for: .milliseconds(50))
    }
  }
  private func runSmokeTest(_ host: HeadlessWasmer) async {
    var report: [String: Any] = ["passed": false, "renderer": "libghostty-vt", "osVersion": ProcessInfo.processInfo.operatingSystemVersionString]
    do {
      try? FileManager.default.removeItem(at: directory.appendingPathComponent("terminal-test.txt"))
      try await waitFor("wasmer:")
      // Keep the test prompt visible even inside a long temporary project path.
      // Readline can otherwise horizontally scroll its prefix out of the stream.
      try await host.writeTerminal(Data("PS1='wasmer: $ '\r".utf8))
      try await host.writeTerminal(Data("printf '\\n%s\\n' SHELL_OK\r".utf8))
      try await waitFor("\nSHELL_OK\n")
      try await host.writeTerminal(Data("python -q\r".utf8))
      try await waitFor(">>> ")
      view.insertText("print(6 * 7)\n")
      await inputTask?.value
      try await waitFor("\n42\n")
      try await host.writeTerminal(Data("print('INPUT_OK:' + input('Name: '))\r".utf8))
      try await waitFor("Name: ")
      try await host.writeTerminal(Data("mobile\r".utf8))
      try await waitFor("INPUT_OK:mobile")
      try await host.writeTerminal(Data("from pathlib import Path; _ = Path('/native/terminal-test.txt').write_text('native terminal IO'); print('FILE_READY')\r".utf8))
      // Wait until readline has restored its input mode before sending EOF.
      try await waitFor("\nFILE_READY\n>>> ")
      let beforeEOF = text.count
      view.sendControl(4)
      await inputTask?.value
      try await waitFor("wasmer:", after: beforeEOF)
      try await host.writeTerminal(Data("cowsay 'iOS terminal'\r".utf8))
      try await waitFor("^__^")
      try await host.resizeTerminal(columns: 73, rows: 19)
      try await host.writeTerminal(Data("python -c \"import os; print('SIZE', *os.get_terminal_size())\"\r".utf8))
      try await waitFor("\nSIZE 73 19\n")
      try await host.resizeTerminal(columns: view.columns, rows: view.rows)
      try await host.writeTerminal(Data("python -u -c \"import time; print('SLEEPING'); time.sleep(30)\"\r".utf8))
      try await waitFor("\nSLEEPING\n")
      let beforeInterrupt = text.count
      view.sendControl(3)
      await inputTask?.value
      try await waitFor("wasmer:", after: beforeInterrupt, timeout: 5)
      try await host.writeTerminal(Data("printf '\\033[32mRENDER_OK\\033[0m\\n'\r".utf8))
      try await waitFor("\nRENDER_OK\n")
      guard String(decoding: transcript, as: UTF8.self).contains("\u{1b}[32mRENDER_OK") else {
        throw WebKitRuntimeError.failed("Missing ANSI output")
      }
      guard view.visibleText.contains("RENDER_OK") else { throw WebKitRuntimeError.failed("Ghostty did not render terminal output") }
      guard try String(contentsOf: directory.appendingPathComponent("terminal-test.txt"), encoding: .utf8) == "native terminal IO" else {
        throw WebKitRuntimeError.failed("Native file verification failed")
      }
      // Exercise the Ghostty encoder and native input queue with shell history.
      let beforeHistory = text.count
      view.sendKey(0); view.sendKey(5)
      await inputTask?.value
      try await waitFor("\nRENDER_OK\n", after: beforeHistory)
      try await host.writeTerminal(Data("node -e \"console.log('NODE_OK:' + (6 * 7))\"\r".utf8))
      try await waitFor("\nNODE_OK:42\n")
      let installDirectory = directory.appendingPathComponent(".network-smoke-" + UUID().uuidString)
      try FileManager.default.createDirectory(at: installDirectory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: installDirectory) }
      try await shellCheck(host, command: "node -e \"require('node:dns').lookup('registry.npmjs.org', (e,a) => { if(e) throw e; console.log('DNS_OK:' + a); })\"", marker: "\nDNS_OK:")
      try await shellCheck(host, command: "node -e \"require('node:https').get('https://registry.npmjs.org/react/latest', r => { let b=''; r.on('data', c=>b+=c); r.on('end', ()=>console.log('HTTPS_OK:' + JSON.parse(b).name)); }).on('error', e=>{throw e})\"", marker: "\nHTTPS_OK:react")
      let installPath = "/native/" + installDirectory.lastPathComponent
      try await shellCheck(host, command: "cd \(installPath) && printf '\\nPROJECT_READY\\n'", marker: "\nPROJECT_READY\n")
      try await shellCheck(host, command: "pnpm i react", marker: "using pnpm v", timeout: 180)
      try await shellCheck(host, command: "printf '\\nPNPM_EXIT:%s\\n' \"$?\"", marker: "\nPNPM_EXIT:0\n")
      try await shellCheck(host, command: "node -e \"console.log('REACT_OK:' + require('react').version)\"; printf '\\nREACT_EXIT:%s\\n' \"$?\"", marker: "\nREACT_OK:")
      try await shellCheck(host, command: "cd /native && printf '\\nPROJECT_DONE\\n'", marker: "\nPROJECT_DONE\n")
      report["nativeNetwork"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(await host.nativeNetworkStats))
      try await host.writeTerminal(Data("node /native/node/server.js; printf '\\nSERVER_EXIT:%s\\n' \"$?\"\r".utf8))
      try await waitFor("Node.js listening on http://localhost:8000")
      let nodePreview = try await waitForPreview(port: 8000, heading: "node-preview", health: "node-health")
      report["nodePreviewTitle"] = try await nodePreview.webView.evaluateJavaScript("document.title")
      let paths = try await nodePreview.webView.callAsyncJavaScript(
        "return await (await fetch('/inspect?q=ios', {method:'POST', body:'hello from WebKit'})).text();",
        arguments: [:], in: nil, contentWorld: .page) as? String
      guard paths?.contains("POST /inspect?q=ios") == true else {
        throw WebKitRuntimeError.failed("Preview lost the request method or query string")
      }
      let beforeNodeStop = text.count
      view.sendControl(3); await inputTask?.value
      try await waitFor("wasmer:", after: beforeNodeStop, timeout: 5)
      try await waitForPreviewClosure(port: 8000)
      // Reuse the same guest port for another runtime and ensure preview cleanup.
      try await host.writeTerminal(Data("python /native/python/server.py\r".utf8))
      try await waitFor("Python listening on http://localhost:8000")
      let pythonPreview = try await waitForPreview(port: 8000, heading: "python-preview", health: "python-health")
      report["pythonPreviewTitle"] = try await pythonPreview.webView.evaluateJavaScript("document.title")
      let beforePythonStop = text.count
      view.sendControl(3); await inputTask?.value
      try await waitFor("wasmer:", after: beforePythonStop, timeout: 5)
      try await waitForPreviewClosure(port: 8000)
      report["visibleText"] = view.visibleText
      report["webViewAttached"] = host.isWebViewAttached
      report["nativeOperations"] = await host.nativeOperationCount
      try await host.writeTerminal(Data("exit 0\r".utf8))
      let deadline = ContinuousClock.now + .seconds(20)
      while exit == nil, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(50)) }
      guard exit?.exitCode == 0, !host.isWebViewAttached else { throw WebKitRuntimeError.failed("Terminal exit \(String(describing: exit?.exitCode)); runtime attached: \(host.isWebViewAttached)") }
      let network = await host.nativeNetworkStats
      guard network.resolutions >= 2, network.connections >= 2, network.bytesRead > 0, network.openSockets == 0 else {
        throw WebKitRuntimeError.failed("Native network did not transfer data or release sockets")
      }
      report["nativeNetworkAfterExit"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(network))
      report["passed"] = true
      report["checks"] = ["bash", "Python REPL", "interactive stdin", "EOF", "cowsay", "resize", "Ctrl-C", "native file", "Ghostty rendering", "keyboard input", "history arrow", "Node.js", "native DNS", "native HTTPS", "pnpm install React", "native socket cleanup", "Node WebView", "absolute fetch", "POST and query", "preview isolation", "preview cleanup", "Python WebView", "port reuse", "exit"]
    } catch {
      report["error"] = error.localizedDescription
      report["nativeNetworkOnError"] = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(await host.nativeNetworkStats))
    }
    report["transcript"] = text
    writeReport(report)
  }
  private func shellCheck(_ host: HeadlessWasmer, command: String, marker: String, timeout: Int = 60) async throws {
    let before = text.count
    try await host.writeTerminal(Data((command + "\r").utf8))
    try await waitFor(marker, after: before, timeout: timeout)
    let output = text
    let range = output.range(of: marker, range: output.index(output.startIndex, offsetBy: before)..<output.endIndex)!
    // Output alone does not mean the foreground process has restored Bash's TTY.
    try await waitFor("wasmer: $ ", after: output.distance(from: output.startIndex, to: range.upperBound), timeout: timeout)
    try await Task.sleep(for: .milliseconds(200))
  }
  private func waitForPreview(port: UInt16, heading: String, health: String) async throws -> ServerPreview {
    let deadline = ContinuousClock.now + .seconds(60)
    while ContinuousClock.now < deadline {
      if let preview = previews.first(where: { $0.port == port }), preview.webView.window != nil {
        let ready = try? await preview.webView.callAsyncJavaScript(
          "return !!document.getElementById(heading) && document.getElementById(health)?.textContent === '/health is ready' && !window.webkit?.messageHandlers?.wasmer;",
          arguments: ["heading": heading, "health": health], in: nil, contentWorld: .page) as? Bool
        if ready == true {
          guard preview.error == nil else {
            throw WebKitRuntimeError.failed("Preview displayed an error: \(preview.error!)")
          }
          return preview
        }
      }
      try await Task.sleep(for: .milliseconds(100))
    }
    throw WebKitRuntimeError.failed("Visible preview did not load \(heading) and fetch /health")
  }

  private func waitForPreviewClosure(port: UInt16) async throws {
    let deadline = ContinuousClock.now + .seconds(5)
    while previews.contains(where: { $0.port == port }) || openingPorts.contains(port) {
      guard ContinuousClock.now < deadline else { throw WebKitRuntimeError.failed("Stopped server preview stayed open") }
      try await Task.sleep(for: .milliseconds(100))
    }
  }

  private func writeReport(_ report: [String: Any]) {
    do {
      let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
      try data.write(to: URL.documentsDirectory.appendingPathComponent("terminal-result.json"), options: .atomic)
    } catch { status = error.localizedDescription }
  }
}
