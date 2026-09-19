import Foundation
import WasmerSDK

/// Application orchestration built entirely on the cross-platform SDK API.
@MainActor
final class ShellRuntime {
  private let client: Wasmer
  private let directory: URL
  private var sandbox: Sandbox?
  private var process: WasmerSDK.Process?
  private var outputTask: Task<Void, Never>?
  private var portTask: Task<Void, Never>?
  var onProgress: ((String) -> Void)?
  var onTerminalOutput: ((Data) -> Void)?
  var onTerminalExit: ((Output) -> Void)?
  var onTerminalFailure: ((Error) -> Void)?
  var onListeningPortsChanged: (([UInt16]) -> Void)?
  private(set) var isWebViewAttached = false

  init(directory: URL) throws {
    self.directory = directory
    client = try Wasmer()
  }
  var nativeOperationCount: Int { get async { await client.diagnostics().nativeOperations } }
  var nativeNetworkStats: NetworkDiagnostics { get async { await client.diagnostics().network } }

  func start() async throws {
    // Startup is lazy. Package loading performs the runtime's JSPI check.
    onProgress?("Loading Python…")
    let python = try await client.packages.load("python/python@=3.13.20")
    onProgress?("Loading cowsay…")
    let cowsay = try await client.packages.load("syrusakbary/cowsay@=0.3.0")
    onProgress?("Loading Node.js…")
    let node = try await client.packages.load("wasmer/edgejs@=0.2.0")
    sandbox = try await client.sandboxes.create(
      packages: [.package(python), .package(cowsay), .package(node)],
      env: [
        "HOME": "/native",
        "PIP_EXTRA_INDEX_URL": "https://python-registry.wasmer.app/simple/",
        "PIP_PLATFORM": "wasix_wasm32",
        "PIP_ONLY_BINARY": ":all:",
        "PIP_TARGET": "/native/wasix-packages",
        "PYTHONPATH": "/native/wasix-packages",
      ],
      network: .host,
      mounts: [
        .init("/native", directory: directory),
        .init("/readonly", directory: directory, readOnly: true),
      ])
    shell = try python.command("bash")
    isWebViewAttached = await client.diagnostics().webViewAttached
  }
  private var shell: CommandRef?

  func startTerminal(columns: Int, rows: Int) async throws {
    guard let sandbox, let shell else { throw DemoError.failed("Shell is not initialized") }
    let process = try await sandbox.command(
      shell,
      ["--noprofile", "--norc", "-c", "exec bash --noprofile --norc -i 2>&1"], cwd: "/native",
      env: ["TERM": "xterm-256color", "PS1": "\\[\\e[38;5;42m\\]wasmer\\[\\e[0m\\]:\\w $ "]
    )
    .spawn(stdin: .pipe, terminal: TerminalOptions(columns: UInt32(columns), rows: UInt32(rows)))
    self.process = process
    outputTask = Task { [weak self] in
      do {
        async let completion = process.wait()
        async let stderr: Void = Self.drain(process.stderr)
        if let stream = process.stdout {
          for try await bytes in stream { self?.onTerminalOutput?(bytes) }
        }
        try await stderr
        let result = try await completion
        self?.portTask?.cancel()
        try await sandbox.close()
        self?.onListeningPortsChanged?([])
        self?.onTerminalExit?(result)
      } catch {
        self?.portTask?.cancel()
        self?.onListeningPortsChanged?([])
        self?.onTerminalFailure?(error)
        try? await self?.client.close()
      }
    }
    portTask = Task { [weak self] in
      var previous: [UInt16] = []
      do {
        while !Task.isCancelled {
          if let ports = try await sandbox.ports.listening(), ports != previous {
            previous = ports
            self?.onListeningPortsChanged?(ports)
          }
          try await Task.sleep(for: .milliseconds(200))
        }
      } catch is CancellationError {} catch {
        if !Task.isCancelled { self?.onProgress?(error.localizedDescription) }
      }
    }
  }
  private static func drain(_ stream: ProcessStream?) async throws {
    if let stream { for try await _ in stream {} }
  }
  func writeTerminal(_ bytes: Data) async throws { try await process?.stdin?.write(bytes) }
  func resizeTerminal(columns: Int, rows: Int) async throws {
    try await process?.resizeTerminal(columns: UInt32(columns), rows: UInt32(rows))
  }
  func expose(_ port: UInt16) async throws -> ExposedPort {
    guard let sandbox else { throw DemoError.failed("Shell is closed") }
    return try await sandbox.ports.expose(port)
  }
  func close() async {
    portTask?.cancel()
    process?.kill()
    // The entire client belongs to this terminal. Closing its transport releases
    // pending reads/writes even if the guest or its worker has stopped responding.
    // Waiting for a sandbox RPC first would also hang the Restart button.
    try? await client.close()
    await outputTask?.value
    process = nil
    sandbox = nil
  }
}
enum DemoError: Error, LocalizedError {
  case failed(String)
  var errorDescription: String? {
    switch self {
    case .failed(let message): message
    }
  }
}
