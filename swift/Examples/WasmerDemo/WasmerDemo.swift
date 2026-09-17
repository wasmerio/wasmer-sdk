import Foundation
import SwiftUI
import WasmerSDK

@main
struct WasmerDemo: App {
  var body: some Scene {
    WindowGroup("Wasmer for Swift") { ContentView() }
  }
}

private struct ContentView: View {
  @State private var output = "Run Python inside a Wasmer sandbox."
  @State private var running = false

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Wasmer for Swift").font(.title)
      Text("Python runs locally in WebAssembly. The first run downloads its package.")
        .foregroundStyle(.secondary)
      ScrollView {
        Text(output)
          .font(.system(.body, design: .monospaced))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      HStack {
        Button("Run Python") {
          running = true
          output = "Loading Python…"
          Task {
            do {
              output = try await Task.detached { try await runPython() }.value
            } catch {
              output = error.localizedDescription
            }
            running = false
          }
        }
        .disabled(running)
        if running { ProgressView().controlSize(.small) }
      }
    }
    .padding(24)
    .frame(minWidth: 560, minHeight: 320)
  }
}

private func runPython() async throws -> String {
  let wasmer = try Wasmer()
  do {
    let sandbox = try await wasmer.sandboxes.create(packages: ["python/python@=3.13.20"])
    do {
      let output = try await sandbox.command(
        "python", ["-c", "import sys; print(sys.version); print('Hello from a Swift app!')"]
      ).run(timeout: 30)
      let text = try output.text()
      try await sandbox.close()
      try await wasmer.close()
      return text
    } catch {
      try? await sandbox.close()
      throw error
    }
  } catch {
    try? await wasmer.close()
    throw error
  }
}
