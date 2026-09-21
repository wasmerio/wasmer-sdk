import Foundation
import WebKit
import WasmerSDK

// Included by build.py only for test/stress builds.
@MainActor
extension TerminalSession {
  var smoke: Bool { ProcessInfo.processInfo.arguments.contains("--smoke-test") }
  var stress: Bool { ProcessInfo.processInfo.arguments.contains("--stress-test") }

  func startIntegrationTests(_ host: ShellRuntime) -> Bool {
    guard smoke || stress else { return false }
    if !integrationTestsStarted {
      integrationTestsStarted = true
      Task {
        if stress { await runStressTest(host) }
        else { await runSmokeTest(host) }
      }
    }
    return true
  }

  func reportTestProgress() {
    guard smoke || stress else { return }
    try? Data(status.utf8).write(to: URL.documentsDirectory.appendingPathComponent("terminal-progress.txt"), options: .atomic)
  }

  private func runSmokeTest(_ host: ShellRuntime) async {
    if ProcessInfo.processInfo.arguments.contains("--example-picker") {
      await runPickerSmokeTest()
      return
    }
    if ProcessInfo.processInfo.arguments.contains("--example-storage") {
      await runStorageSmokeTest(host)
      return
    }
    if ProcessInfo.processInfo.arguments.contains("--example-node-next") {
      await runNextSmokeTest(host)
      return
    }
    var report: [String: Any] = ["passed": false, "renderer": "libghostty-vt", "osVersion": ProcessInfo.processInfo.operatingSystemVersionString]
    do {
      try? FileManager.default.removeItem(at: directory.appendingPathComponent("terminal-test.txt"))
      try await waitFor("➜ ~ $ ")
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
        throw DemoError.failed("Missing ANSI output")
      }
      guard view.visibleText.contains("RENDER_OK") else { throw DemoError.failed("Ghostty did not render terminal output") }
      guard try String(contentsOf: directory.appendingPathComponent("terminal-test.txt"), encoding: .utf8) == "native terminal IO" else {
        throw DemoError.failed("Native file verification failed")
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
      try await host.writeTerminal(Data("node /workspace/node/server.js; printf '\\nSERVER_EXIT:%s\\n' \"$?\"\r".utf8))
      try await waitFor("Node.js listening on http://localhost:8000")
      let nodePreview = try await waitForPreview(port: 8000, heading: "node-preview", health: "node-health")
      report["nodePreviewTitle"] = try await nodePreview.webView.evaluateJavaScript("document.title")
      let paths = try await nodePreview.webView.callAsyncJavaScript(
        "return await (await fetch('/inspect?q=ios', {method:'POST', body:'hello from WebKit'})).text();",
        arguments: [:], in: nil, contentWorld: .page) as? String
      guard paths?.contains("POST /inspect?q=ios") == true else {
        throw DemoError.failed("Preview lost the request method or query string")
      }
      try await checkPreviewNavigation(nodePreview)
      let beforeNodeStop = text.count
      view.sendControl(3); await inputTask?.value
      try await waitFor("wasmer:", after: beforeNodeStop, timeout: 5)
      try await waitForPreviewClosure(port: 8000)
      // Reuse the same guest port for another runtime and ensure preview cleanup.
      try await host.writeTerminal(Data("python /workspace/python/server.py\r".utf8))
      try await waitFor("Python listening on http://localhost:8000")
      let pythonPreview = try await waitForPreview(port: 8000, heading: "python-preview", health: "python-health")
      report["pythonPreviewTitle"] = try await pythonPreview.webView.evaluateJavaScript("document.title")
      let beforePythonStop = text.count
      view.sendControl(3); await inputTask?.value
      try await waitFor("wasmer:", after: beforePythonStop, timeout: 5)
      try await waitForPreviewClosure(port: 8000)
      try await checkFastAPIRestarts(host)
      report["visibleText"] = view.visibleText
      report["webViewAttached"] = host.isWebViewAttached
      report["nativeOperations"] = await host.nativeOperationCount
      try await host.writeTerminal(Data("exit 0\r".utf8))
      let deadline = ContinuousClock.now + .seconds(20)
      while exit == nil, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(50)) }
      guard exit?.exitCode == 0, !host.isWebViewAttached else { throw DemoError.failed("Terminal exit \(String(describing: exit?.exitCode)); runtime attached: \(host.isWebViewAttached)") }
      let network = await host.nativeNetworkStats
      guard network.resolutions >= 2, network.connections >= 2, network.bytesRead > 0, network.openSockets == 0 else {
        throw DemoError.failed("Native network did not transfer data or release sockets")
      }
      report["nativeNetworkAfterExit"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(network))
      report["passed"] = true
      report["checks"] = ["bash", "Python REPL", "interactive stdin", "EOF", "cowsay", "resize", "Ctrl-C", "native file", "Ghostty rendering", "keyboard input", "history arrow", "Node.js", "native DNS", "native HTTPS", "pnpm install React", "native socket cleanup", "Node WebView", "browser address bar", "browser back and forward", "absolute fetch", "POST and query", "preview isolation", "preview cleanup", "Python WebView", "port reuse", "FastAPI install", "FastAPI HTTP validation", "FastAPI repeated Ctrl-C and restart", "Python after cancellation", "exit"]
    } catch {
      report["error"] = error.localizedDescription
      report["nativeNetworkOnError"] = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(await host.nativeNetworkStats))
    }
    report["transcript"] = text
    writeReport(report)
  }
  private func runStorageSmokeTest(_ host: ShellRuntime) async {
    var report: [String: Any] = ["passed": false, "storage": storage.rawValue]
    let name = ".storage-test-" + UUID().uuidString
    do {
      try await waitFor("➜ ~ $ ")
      try await host.writeTerminal(Data("PS1='wasmer: $ '\r".utf8))
      try await host.fs.writeText("/workspace/" + name + "/from-swift.txt", "shared storage")
      try await host.fs.writeText(name + "/test.cjs", """
        const fs = require('fs');
        if (fs.readFileSync('from-swift.txt', 'utf8') !== 'shared storage') throw Error('Swift write missing');
        const times = {}, start = Date.now(), bytes = Buffer.alloc(4 * 1024 * 1024, 37);
        fs.writeFileSync('binary', bytes); times.write4MiB = Date.now() - start;
        let t = Date.now(); for (let i=0; i<500; i++) fs.statSync('binary'); times.stat500 = Date.now()-t;
        t = Date.now(); for (let i=0; i<4; i++) { const b = fs.readFileSync('binary'); if (b.length !== bytes.length || b[123] !== 37) throw Error('Invalid binary'); }
        times.read16MiB = Date.now()-t;
        fs.mkdirSync('before'); fs.writeFileSync('before/value', 'from guest'); fs.renameSync('before','after');
        fs.writeFileSync('result.json', JSON.stringify(times));
        console.log('STORAGE_READY');
        """)
      let operations = await host.nativeOperationCount
      try await shellCheck(host, command: "cd /workspace/\(name) && node test.cjs; printf '\\nSTORAGE_EXIT:%s\\n' \"$?\"", marker: "\nSTORAGE_EXIT:0\n")
      report["nativeOperations"] = await host.nativeOperationCount - operations
      report["timingsMs"] = try JSONSerialization.jsonObject(with: try await host.fs.read(name + "/result.json"))
      guard try await host.fs.readText(name + "/after/value") == "from guest" else { throw DemoError.failed("Guest write missing from Swift") }
      try await host.fs.remove(name + "/binary")
      await restart()
      try await waitFor("➜ ~ $ ")
      guard let reopened = runtime else { throw DemoError.failed("Restart failed") }
      let found = try await reopened.fs.readDir().contains { $0.name == name }
      guard found == (storage != .memory) else { throw DemoError.failed("Unexpected storage persistence") }
      if found {
        guard try await reopened.fs.readText(name + "/after/value") == "from guest" else { throw DemoError.failed("Stored contents lost after restart") }
        try await reopened.fs.remove(name, recursive: true)
      }
      report["checks"] = ["Swift write visible to guest", "guest write visible to Swift", "binary IO", "directory rename", "restart persistence", "recursive removal"]
      report["passed"] = true
    } catch { report["error"] = error.localizedDescription }
    report["transcript"] = text
    writeReport(report)
  }

  private func runNextSmokeTest(_ host: ShellRuntime) async {
    var report: [String: Any] = ["passed": false, "example": "node-next"]
    do {
      // Start from source only and install all dependencies inside the guest.
      let existing = ProcessInfo.processInfo.arguments.contains("--reuse-next-project")
      let name = existing ? "node-next" : ".node-next-smoke-" + UUID().uuidString
      let workspace = "/workspace/" + name
      try await host.seedExamples("node-next", at: workspace)
      report["workspace"] = workspace
      report["storage"] = storage.rawValue
      report["freshPackageCache"] = !existing
      let compiler = workspace + "/node_modules/next/wasm/@next/swc-wasm-nodejs/wasm_bg.wasm"
      let entries = try await host.fs.readDir(workspace)
      guard existing || !entries.contains(where: { $0.name == "node_modules" })
      else { throw DemoError.failed("Cold-start test must not bundle dependencies") }
      try await waitFor("➜ ~ $ ")
      try await host.writeTerminal(Data("PS1='wasmer: $ '\r".utf8))
      // A fresh project can still reuse the global pnpm store. Keep both
      // caches in this unique directory so archive download/hash/extraction
      // are exercised on every backend, including persistent OPFS volumes.
      let cacheConfig = existing ? "" : "export npm_config_store_dir=\(workspace)/.pnpm-store npm_config_cache_dir=\(workspace)/.pnpm-cache && "
      try await shellCheck(host, command: "cd \(workspace) && \(cacheConfig)printf '\\n%s\\n' NEXT_DIRECTORY", marker: "\nNEXT_DIRECTORY\n")
      status = "Installing Next.js · " + storage.label
      let installStarted = ProcessInfo.processInfo.systemUptime
      try await shellCheck(host, command: "pnpm i; printf '\\nNEXT_INSTALL:%s\\n' \"$?\"", marker: "\nNEXT_INSTALL:", timeout: 480)
      guard text.contains("\nNEXT_INSTALL:0\n") else { throw DemoError.failed("pnpm install failed") }
      report["installMs"] = Int((ProcessInfo.processInfo.systemUptime - installStarted) * 1000)
      report["restartedAfterInstall"] = false
      var serverRuns: [[String: Any]] = []
      let arguments = ProcessInfo.processInfo.arguments
      let countIndex = arguments.firstIndex(of: "--next-runs")
      let repetitions = countIndex.flatMap { $0 + 1 < arguments.count ? Int(arguments[$0 + 1]) : nil } ?? 3
      guard (1...20).contains(repetitions) else { throw DemoError.failed("Next.js test requires 1–20 runs") }
      report["requestedRuns"] = repetitions
      for attempt in 0..<repetitions {
        var cycle: [String: Any] = ["attempt": attempt + 1]
        if attempt > 0 {
          let output = try await shellCheck(host, command: "cd \(workspace) && pnpm i; printf '\\nNEXT_REINSTALL:%s\\n' \"$?\"", marker: "\nNEXT_REINSTALL:", timeout: 120)
          guard output.contains("\nNEXT_REINSTALL:0\n") else { throw DemoError.failed("pnpm reinstall failed") }
        }
        status = "Next.js \(attempt + 1)/\(repetitions) · " + storage.label
        try await shellCheck(host, command: "node -e \"console.log('NEXT_VERSION:' + require('next/package.json').version)\"", marker: "\nNEXT_VERSION:16.3.3\n")
        let before = text.count
        let operationsBefore = await host.nativeOperationCount
        let startedAt = ProcessInfo.processInfo.systemUptime
        try await host.writeTerminal(Data("cd \(workspace) && pnpm dev; printf '\\nNEXT_EXIT:%s\\n' \"$?\"\r".utf8))
        try await waitFor("Ready in", after: before, timeout: 180, failureMarker: "\nNEXT_EXIT:")
        cycle["startupMs"] = Int((ProcessInfo.processInfo.systemUptime - startedAt) * 1000)
        let deadline = ContinuousClock.now + .seconds(180)
        var loaded: ServerPreview?
        var previewBody = ""
        while ContinuousClock.now < deadline {
          let output = String(text.dropFirst(before))
          guard ready, !output.contains("\nNEXT_EXIT:") else {
            throw DemoError.failed("Next.js stopped before the browser page loaded: \(status)")
          }
          if output.contains("⨯") || output.contains("uncaughtException:") {
            throw DemoError.failed("Next.js compilation failed; see the terminal transcript")
          }
          if let preview = previews.first(where: { $0.port == 3000 }), preview.webView.window != nil {
            if let error = preview.error { throw DemoError.failed("Next.js preview: \(error)") }
            if !preview.isLoading {
              previewBody = (try? await preview.webView.evaluateJavaScript("document.body?.textContent ?? ''") as? String) ?? ""
              if previewBody.contains("Welcome to Next.js on Wasmer.") {
                loaded = preview
                break
              }
            }
          }
          try await Task.sleep(for: .milliseconds(200))
        }
        guard let preview = loaded else { throw DemoError.failed("Next.js page did not load in the browser preview: \(previewBody.prefix(1000))") }
        cycle["firstPageMs"] = Int((ProcessInfo.processInfo.systemUptime - startedAt) * 1000)
        cycle["firstPageNativeOperations"] = await host.nativeOperationCount - operationsBefore
        guard (try await host.fs.stat(compiler)).size > 0 else {
          throw DemoError.failed("Next.js did not download the WebAssembly compiler")
        }
        let hello = try await preview.webView.callAsyncJavaScript(
          "return (await (await fetch('/api/hello', {signal: AbortSignal.timeout(30000)})).json()).hello;", arguments: [:], in: nil, contentWorld: .page) as? String
        guard hello == "from Next.js on Wasmer" else { throw DemoError.failed("Next.js API route failed") }
        report["address"] = preview.address
        report["apiResponse"] = hello
        view.sendControl(3); await inputTask?.value
        try await waitFor("\nNEXT_EXIT:", after: before)
        try await waitForPreviewClosure(port: 3000)
        try await shellCheck(host, command: "cd /workspace && node -e \"console.log('NEXT_STOPPED')\"; printf '\\nNEXT_RECOVERY:%s\\n' \"$?\"", marker: "\nNEXT_RECOVERY:0\n")
        serverRuns.append(cycle)
        report["serverRuns"] = serverRuns
      }
      for (key, value) in serverRuns[0] where key != "attempt" { report[key] = value }
      report["checks"] = [existing ? "cached pnpm install" : "cold pnpm install", "Next.js downloads its WebAssembly compiler", "same runtime after install", "\(repetitions) server/page/API cycles", "warm pnpm install", "Ctrl-C", "port cleanup", "terminal recovery"]
      if !existing { try await host.fs.remove(workspace, recursive: true) }
      report["passed"] = true
    } catch { report["error"] = error.localizedDescription }
    report["transcript"] = text
    writeReport(report)
  }
  private func runPickerSmokeTest() async {
    var checks: [String] = []
    let examples = ["node", "node-express", "python-flask", "python-django", "ffmpeg", "yt-dlp"]
    let markerFile = ".picker-isolation-" + UUID().uuidString
    do {
      for id in examples {
        guard let example = ShellExample.all.first(where: { $0.id == id }) else {
          throw DemoError.failed("Missing example \(id)")
        }
        await chooseExample(example)
        guard let host = runtime else { throw DemoError.failed(status) }
        try await waitFor("➜ ~ $ ")
        try await host.writeTerminal(Data("PS1='wasmer: $ '\r".utf8))
        let isolation: String
        if example.group == "Node.js" {
          isolation = "command -v node && ! command -v python && ! command -v ffmpeg"
        } else if id == "ffmpeg" {
          isolation = "command -v ffmpeg && command -v ffprobe && ! command -v python && ! command -v node"
        } else {
          isolation = "command -v python && ! command -v node"
        }
        try await shellCheck(host, command: "test \"$PWD\" = /workspace && test -f README.md && test ! -d /workspace/\(id) && test ! -e \(markerFile) && test \"$PIP_TARGET\" = /workspace/.python-packages && test \"$PYTHONPATH\" = /workspace/.python-packages && \(isolation); printf '\\nPICKER_ISOLATION:%s\\n' \"$?\"", marker: "\nPICKER_ISOLATION:0\n")
        try await host.fs.writeText(markerFile, id)
        checks.append(id + " runtime isolation and working directory")
        if let install = example.install {
          status = "Testing \(example.title) install…"
          let installed = try await shellCheck(host, command: "\(install); printf '\\nPICKER_INSTALL:%s\\n' \"$?\"", marker: "\nPICKER_INSTALL:", timeout: 240)
          guard installed.contains("\nPICKER_INSTALL:0\n") else { throw DemoError.failed("Dependency installation failed for \(id): \(installed.suffix(2000))") }
          checks.append(id + " install")
        }
        if id == "python-django" {
          try await shellCheck(host, command: "test -f manage.py && test -f mysite/urls.py && python manage.py check && python manage.py migrate --noinput && python manage.py migrate --check; printf '\\nPICKER_DJANGO:%s\\n' \"$?\"", marker: "\nPICKER_DJANGO:0\n", timeout: 180)
          checks.append("Django starter project and SQLite migrations")
        }
        if id == "yt-dlp" {
          try await shellCheck(host, command: "qjs --version && ffmpeg -version && /workspace/.python-packages/bin/yt-dlp --version && python -c 'import yt_dlp_ejs'; printf '\\nPICKER_TOOLS:%s\\n' \"$?\"", marker: "\nPICKER_TOOLS:0\n")
          let usage = try await shellCheck(host, command: "\(example.run); printf '\\nPICKER_HELP:%s\\n' \"$?\"", marker: "\nPICKER_HELP:0\n")
          guard usage.contains("Usage: yt-dlp [OPTIONS] URL") else { throw DemoError.failed("Missing yt-dlp usage instructions") }
          checks.append("yt-dlp tools and CLI help")
          if let url = ProcessInfo.processInfo.environment["WASMER_YTDLP_TEST_URL"] {
            let quotedURL = "'" + url.replacingOccurrences(of: "'", with: "'\\''") + "'"
            let download = try await shellCheck(host, command: "/workspace/.python-packages/bin/yt-dlp \(quotedURL); printf '\\nPICKER_DOWNLOAD:%s\\n' \"$?\"", marker: "\nPICKER_DOWNLOAD:", timeout: 300)
            guard download.contains("\nPICKER_DOWNLOAD:0\n") else { throw DemoError.failed("Video download failed: \(download.suffix(2000))") }
            try await shellCheck(host, command: "python -c \"from pathlib import Path; files = list(Path('downloads').glob('*.mp4')); assert files and all(p.stat().st_size > 0 for p in files)\"; printf '\\nPICKER_VIDEO:%s\\n' \"$?\"", marker: "\nPICKER_VIDEO:0\n")
            checks.append("yt-dlp video download and FFmpeg merge")
          }
        } else if id == "ffmpeg" {
          let outputPath = "/workspace/" + markerFile + ".gif"
          let conversion = example.run.replacingOccurrences(of: "/workspace/wordpress.gif", with: outputPath)
          try await shellCheck(host, command: "\(conversion); printf '\\nPICKER_CONVERT:%s\\n' \"$?\"", marker: "\nPICKER_CONVERT:0\n", timeout: 180)
          let metadata = try await shellCheck(host, command: "test -s \(outputPath) && ffprobe -v error -count_frames -show_entries stream=codec_name,width,height,nb_read_frames:format=format_name,duration -of json \(outputPath); printf '\\nPICKER_MEDIA:%s\\n' \"$?\"", marker: "\nPICKER_MEDIA:0\n")
          guard metadata.contains("\"format_name\": \"gif\""), metadata.contains("\"codec_name\": \"gif\""), metadata.contains("\"width\": 320"), metadata.contains("\"height\": 180") else {
            throw DemoError.failed("FFmpeg did not create a GIF at the expected dimensions")
          }
          try await shellCheck(host, command: "test \"$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 \(outputPath))\" -gt 1; printf '\\nPICKER_ANIMATION:%s\\n' \"$?\"", marker: "\nPICKER_ANIMATION:0\n")
          try await host.fs.remove(outputPath)
          guard previews.isEmpty else { throw DemoError.failed("FFmpeg unexpectedly opened a server preview") }
          checks.append("FFmpeg URL conversion to a 320×180 animated GIF")
        } else {
          try await host.writeTerminal(Data((example.run + "\r").utf8))
          let deadline = ContinuousClock.now + .seconds(60)
          while previews.isEmpty {
            guard ContinuousClock.now < deadline else { throw DemoError.failed("Missing server preview for \(id)") }
            try await Task.sleep(for: .milliseconds(100))
          }
          let preview = previews[0]
          let path = id == "python-django" ? "/" : "/health"
          let expected = id == "python-django" ? "The install worked successfully! Congratulations!" : "true"
          var response: String?
          while ContinuousClock.now < deadline {
            response = try? await preview.webView.callAsyncJavaScript("const response = await fetch(path); return response.ok ? await response.text() : null", arguments: ["path": path], in: nil, contentWorld: .page) as? String
            if response?.contains(expected) == true { break }
            try await Task.sleep(for: .milliseconds(100))
          }
          guard response?.contains(expected) == true else { throw DemoError.failed("Preview response failed for \(id)") }
          if id == "python-django" {
            let admin = try await preview.webView.callAsyncJavaScript("""
              const login = await fetch('/admin/login/?next=/admin/');
              const html = await login.text();
              const css = await fetch('/static/admin/css/base.css');
              return login.ok && html.includes('name="username"') && html.includes('name="csrfmiddlewaretoken"') && css.ok && (await css.text()).includes('body');
              """, arguments: [:], in: nil, contentWorld: .page) as? Bool
            guard admin == true else { throw DemoError.failed("Django admin login or static assets failed") }
            checks.append("Django default welcome page, admin login, and static assets")
          }
          view.sendControl(3); await inputTask?.value
          try await waitForPreviewClosure(port: 8000)
          checks.append(id + " HTTP preview and Ctrl-C")
        }
        try await shellCheck(host, command: "printf '\\n%s\\n' PICKER_RECOVERED", marker: "\nPICKER_RECOVERED\n")
      }
      for id in examples {
        await chooseExample(ShellExample.all.first { $0.id == id }!)
        guard let host = runtime else { throw DemoError.failed(status) }
        try await waitFor("➜ ~ $ ")
        if storage == .memory {
          guard !(try await host.fs.readDir()).contains(where: { $0.name == markerFile }) else {
            throw DemoError.failed("Memory workspace unexpectedly retained another session's files")
          }
        } else {
          guard try await host.fs.readText(markerFile) == id else {
            throw DemoError.failed("Persistent workspace was not isolated for \(id)")
          }
          try await host.fs.remove(markerFile)
        }
      }
      checks.append("workspace files remain isolated when reopening examples")
      writeReport(["passed": true, "checks": checks, "storage": storage.rawValue])
      status = "Example picker tests passed"
    } catch {
      writeReport(["passed": false, "error": error.localizedDescription, "checks": checks, "transcript": text])
      status = "Example picker test failed: \(error.localizedDescription)"
    }
  }

  @discardableResult
  private func shellCheck(_ host: ShellRuntime, command: String, marker: String, timeout: Int = 60) async throws -> String {
    let before = text.count
    try await host.writeTerminal(Data((command + "\r").utf8))
    try await waitFor(marker, after: before, timeout: timeout)
    let output = text
    let range = output.range(of: marker, range: output.index(output.startIndex, offsetBy: before)..<output.endIndex)!
    // Output alone does not mean the foreground process has restored Bash's TTY.
    try await waitFor("wasmer: $ ", after: output.distance(from: output.startIndex, to: range.upperBound), timeout: timeout)
    try await Task.sleep(for: .milliseconds(200))
    return String(text.dropFirst(before))
  }
  private func checkPreviewNavigation(_ preview: ServerPreview) async throws {
    let home = "localhost:8000"
    let destination = home + "/inspect?q=hello%20ios#details"
    guard preview.address == home, preview.navigate(to: destination) else {
      throw DemoError.failed("Preview did not accept the guest server address")
    }
    try await waitForAddress(preview, destination)
    guard preview.canGoBack, !preview.canGoForward else {
      throw DemoError.failed("Preview did not publish its navigation history")
    }
    preview.goBack()
    try await waitForAddress(preview, home)
    guard preview.canGoForward else { throw DemoError.failed("Preview forward navigation stayed disabled") }
    preview.goForward()
    try await waitForAddress(preview, destination)
    guard preview.navigate(to: "/health") else { throw DemoError.failed("Preview rejected an absolute server path") }
    try await waitForAddress(preview, home + "/health")
    let body = try await preview.webView.evaluateJavaScript("document.body.textContent") as? String
    guard body?.contains("\"ok\":true") == true else { throw DemoError.failed("Address bar did not load /health") }
    guard !preview.navigate(to: "https://example.com/"), !preview.navigate(to: "javascript:alert(1)") else {
      throw DemoError.failed("Preview navigation escaped its server")
    }
    preview.goBack()
    try await waitForAddress(preview, destination)
  }
  private func waitForAddress(_ preview: ServerPreview, _ address: String) async throws {
    let deadline = ContinuousClock.now + .seconds(15)
    while preview.address != address || preview.isLoading {
      guard preview.error == nil else { throw DemoError.failed(preview.error!) }
      guard ContinuousClock.now < deadline else { throw DemoError.failed("Preview did not navigate to \(address)") }
      try await Task.sleep(for: .milliseconds(50))
    }
  }
  private func checkFastAPIRestarts(_ host: ShellRuntime) async throws {
    try await shellCheck(host, command: "cd /workspace/python-fastapi; printf '\\n%s\\n' FASTAPI_DIRECTORY", marker: "\nFASTAPI_DIRECTORY\n")
    try await shellCheck(host, command: "pip install -r requirements.txt; printf '\\nFASTAPI_INSTALL:%s\\n' \"$?\"", marker: "\nFASTAPI_INSTALL:0\n", timeout: 180)
    for attempt in 0..<3 {
      let before = text.count
      try await host.writeTerminal(Data("python server.py; printf '\\nFASTAPI_\(attempt)_EXIT:%s\\n' \"$?\"\r".utf8))
      try await waitFor("Uvicorn running on", after: before, timeout: 30)
      let deadline = ContinuousClock.now + .seconds(30)
      var verified = false
      while ContinuousClock.now < deadline {
        if let preview = previews.first(where: { $0.port == 8000 }), preview.webView.window != nil {
          verified = (try? await preview.webView.evaluateJavaScript("document.querySelectorAll('#checks li').length === 3 && [...document.querySelectorAll('#checks li')].every(li => li.textContent.startsWith('PASS:'))") as? Bool) == true
          if verified { break }
        }
        try await Task.sleep(for: .milliseconds(100))
      }
      guard verified else { throw DemoError.failed("FastAPI preview did not pass health and validation checks") }
      view.sendControl(3); await inputTask?.value
      try await waitFor("\nFASTAPI_\(attempt)_EXIT:", after: before)
      try await waitForPreviewClosure(port: 8000)
      try await shellCheck(host, command: "python -c \"print('AFTER_CANCEL')\"; printf '\\nPYTHON_AFTER_CANCEL:%s\\n' \"$?\"", marker: "\nPYTHON_AFTER_CANCEL:0\n")
    }
  }
  private func runStressTest(_ host: ShellRuntime) async {
    let quick = ProcessInfo.processInfo.arguments.contains("--stress-quick")
    var checks: [String] = []
    var report: [String: Any] = ["passed": false, "osVersion": ProcessInfo.processInfo.operatingSystemVersionString]
    do {
      try await waitFor("$ ")
      try await host.writeTerminal(Data("PS1='wasmer: $ '\r".utf8))
      var commands = [
        ("Python baseline", "python -c \"print('PYTHON_READY')\""),
      ]
      for round in 0..<(quick ? 0 : 5) {
        commands.append(("pip Flask \(round)", "pip install --force-reinstall --no-cache-dir --upgrade -t /workspace/stress-python flask"))
        commands.append(("input after pip \(round)", "PYTHONPATH=/workspace/stress-python python -c \"import flask; print('FLASK_READY')\""))
      }
      for round in 0..<(quick ? 0 : 3) {
        for example in ["django", "fastapi"] {
          commands.append(("pip requirements \(example) \(round)", "pip install --force-reinstall --no-cache-dir --upgrade -r /workspace/python-\(example)/requirements.txt"))
          commands.append(("import \(example) \(round)", "python -c 'import \(example); print(\(example).__version__)'"))
        }
      }
      for round in 0..<(quick ? 100 : 150) {
        let script = quick ? "import threading,time; ts=[threading.Thread(target=lambda: time.sleep(.01)) for _ in range(3)]; [t.start() for t in ts]; [t.join() for t in ts]; print('KEYBOARD_READY:%s'%\(round))" : "print('KEYBOARD_READY:%s'%\(round))"
        commands.append(("keyboard and child process \(round)", "python -c \"\(script)\""))
      }
      commands.append(("input during output pressure", "python -u -c \"import sys,threading,time; print('OUTPUT_BUSY'); t=threading.Thread(target=lambda: [(sys.stdout.write('x'*4096+'\\\\n'),time.sleep(.002)) for _ in range(512)]); t.start(); s=input(); t.join(); assert s=='stress-input'\""))
      for (index, item) in commands.enumerated() {
        status = "Stress: \(item.0)"
        try Data(status.utf8).write(to: URL.documentsDirectory.appendingPathComponent("terminal-progress.txt"), options: .atomic)
        let command = item.1 + "; printf '\\n__STRESS_%s_DONE__:%s\\n' \(index) \"$?\"\r"
        if item.0.hasPrefix("keyboard") {
          for letter in command { view.insertText(String(letter)) }
        } else {
          try await host.writeTerminal(Data(command.utf8))
        }
        if item.0 == "input during output pressure" {
          try await waitFor("\nOUTPUT_BUSY\n")
          for letter in "stress-input\n" { view.insertText(String(letter)) }
        }
        // Unique split markers survive transcript rotation during output floods.
        try await waitFor("__STRESS_\(index)_DONE__:", timeout: 180)
        guard text.contains("__STRESS_\(index)_DONE__:0") else { throw DemoError.failed("\(item.0) failed") }
        if item.0.hasPrefix("keyboard"), let round = item.0.split(separator: " ").last {
          guard text.contains("\nKEYBOARD_READY:\(round)\n") else { throw DemoError.failed("\(item.0) lost output") }
        }
        checks.append(item.0)
      }
      // Restart with a pending read and queued input; closing must not depend
      // on a guest RPC completing first.
      report["nativeNetwork"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(await host.nativeNetworkStats))
      report["transcriptBeforeRestart"] = String(text.suffix(16000))
      try await host.writeTerminal(Data("python -c 'import time; time.sleep(120)'\r".utf8))
      try await Task.sleep(for: .milliseconds(300))
      send(Data(repeating: 120, count: 256 * 1024))
      await restart()
      try await waitFor("$ ")
      view.insertText("printf '\\n%s\\n' RESTART_OK\n")
      try await waitFor("\nRESTART_OK\n")
      checks.append("restart with pending input")
      report["passed"] = true
    } catch { report["error"] = error.localizedDescription }
    report["checks"] = checks
    report["transcript"] = text
    writeReport(report)
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
            throw DemoError.failed("Preview displayed an error: \(preview.error!)")
          }
          return preview
        }
      }
      try await Task.sleep(for: .milliseconds(100))
    }
    throw DemoError.failed("Visible preview did not load \(heading) and fetch /health")
  }

  private func waitForPreviewClosure(port: UInt16) async throws {
    let deadline = ContinuousClock.now + .seconds(5)
    while previews.contains(where: { $0.port == port }) || openingPorts.contains(port) {
      guard ContinuousClock.now < deadline else { throw DemoError.failed("Stopped server preview stayed open") }
      try await Task.sleep(for: .milliseconds(100))
    }
  }

  func writeReport(_ report: [String: Any]) {
    do {
      let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
      try data.write(to: URL.documentsDirectory.appendingPathComponent("terminal-result.json"), options: .atomic)
    } catch { status = error.localizedDescription }
  }
}
