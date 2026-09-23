import Foundation
import WasmerSDK

/// Application orchestration built entirely on the cross-platform SDK API.
@MainActor
final class ShellRuntime {
  private let client: Wasmer
  private let directory: URL
  private let storage: ShellStorage
  private let example: ShellExample?
  private var sandbox: Sandbox?
  private var process: WasmerSDK.Process?
  private var outputTask: Task<Void, Never>?
  private var portTask: Task<Void, Never>?
  var onProgress: ((String) -> Void)?
  var onPackageProgress: ((PackageLoadProgress?) -> Void)?
  private var loadingPackages = false
  var onTerminalOutput: ((Data) -> Void)?
  var onTerminalExit: ((Output) -> Void)?
  var onTerminalFailure: ((Error) -> Void)?
  var onListeningPortsChanged: (([UInt16]) -> Void)?
  private(set) var isWebViewAttached = false

  init(directory: URL, storage: ShellStorage, example: ShellExample? = nil) throws {
    self.example = example
    self.storage = storage
    // Reuse each example's existing native directory as its workspace root.
    self.directory = example.map { directory.appendingPathComponent($0.id) } ?? directory
    client = try Wasmer()
  }
  var nativeOperationCount: Int { get async { await client.diagnostics().nativeOperations } }
  var nativeNetworkStats: NetworkDiagnostics { get async { await client.diagnostics().network } }

  func start() async throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    // Startup is lazy. Package loading performs the runtime's JSPI check.
    var names = ["wasmer/bash"]
    let required = example?.packages ?? (ShellExample.all.flatMap(\.packages) + ["syrusakbary/cowsay@=0.3.0"])
    for name in required where !names.contains(name) { names.append(name) }
    let sources: [PackageSource] = names.map { name in
      if name == "wasmer/edge@=0.2.1", let url = Bundle.main.url(forResource: "edgejs", withExtension: "webc") { return .file(url) }
      return .registry(name)
    }
    loadingPackages = true
    defer { loadingPackages = false; onPackageProgress?(nil) }
    let packages = try await client.packages.loadMany(sources) { [weak self] progress in
      Task { @MainActor in
        guard let self, self.loadingPackages else { return }
        self.onPackageProgress?(progress)
        let label = progress.phase == .resolving ? "Resolving packages" : progress.phase == .downloading ? "Downloading packages" : "Preparing packages"
        let detail = progress.download.percent.map { "\(Int($0))%" } ?? String(format: "%.1f MB", Double(progress.download.downloadedBytes) / 1_000_000)
        self.onProgress?("\(label) · \(detail)")
      }
    }
    loadingPackages = false
    onPackageProgress?(nil)
    let pythonPath = example == nil ? "/workspace/wasix-packages" : "/workspace/.python-packages"
    sandbox = try await client.sandboxes.create(
      packages: packages.map { .package($0) },
      env: [
        "HOME": "/workspace",
        "npm_config_store_dir": "/workspace/.pnpm-store",
        "npm_config_cache_dir": "/workspace/.pnpm-cache",
        "npm_config_network_concurrency": "1",
        "PATH": "/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.",
        "PIP_EXTRA_INDEX_URL": "https://python-registry.wasmer.app/simple/",
        "PIP_PLATFORM": "wasix_wasm32",
        "PIP_ONLY_BINARY": ":all:",
        "PIP_TARGET": pythonPath,
        "PYTHONPATH": pythonPath,
      ].merging(ShellExample.environment(for: example)) { _, value in value },
      network: .host,
      mounts: [
        .init("/native", directory: directory),
        .init("/readonly", directory: directory, readOnly: true),
      ], storage: storage.backend(directory: directory, exampleID: example?.id))
    shell = try packages[0].command("bash")
    isWebViewAttached = await client.diagnostics().webViewAttached
  }
  var fs: SandboxFileSystem {
    get throws {
      guard let sandbox else { throw DemoError.failed("Shell is closed") }
      return sandbox.fs
    }
  }
  func seedExamples(_ name: String? = nil, at destination: String = ".") async throws {
    let root = Bundle.main.resourceURL!.appendingPathComponent("Examples")
    let source = name.map { root.appendingPathComponent($0) } ?? root
    try await copyMissing(source, to: destination)
  }
  private func copyMissing(_ source: URL, to destination: String) async throws {
    let fs = try fs
    try await fs.mkdir(destination)
    let existing = Set(try await fs.readDir(destination).map(\.name))
    for file in try FileManager.default.contentsOfDirectory(at: source, includingPropertiesForKeys: [.isDirectoryKey]) {
      let target = destination + "/" + file.lastPathComponent
      if try file.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true {
        try await copyMissing(file, to: target)
      } else if !existing.contains(file.lastPathComponent) {
        try await fs.write(target, Data(contentsOf: file))
      }
    }
  }
  private var shell: CommandRef?

  func startTerminal(columns: Int, rows: Int) async throws {
    guard let sandbox, let shell else { throw DemoError.failed("Shell is not initialized") }
    let process = try await sandbox.command(
      shell,
      ["--noprofile", "--norc", "-c", "exec bash --noprofile --norc -i 2>&1"], cwd: "/workspace",
      // Keep the prompt identical to wasmer.sh's .bashrc.
      env: ["TERM": "xterm-256color", "PS1": "\\[\\033[1;38;5;141m\\]➜\\[\\033[0m\\] \\[\\033[1;38;5;117m\\]\\W\\[\\033[0m\\] \\[\\033[1m\\]$\\[\\033[0m\\] "]
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

/// Changing storage starts a new shell; native and OPFS volumes retain files.
enum ShellStorage: String, CaseIterable {
  case native, memory, opfs
  var label: String {
    switch self { case .native: "Native"; case .memory: "Memory"; case .opfs: "OPFS" }
  }
  func backend(directory: URL, exampleID: String? = nil) -> SandboxStorage {
    switch self {
    case .native: .native(directory)
    case .memory: .memory
    case .opfs: .opfs(exampleID.map { "WasmerShell-example-" + $0 } ?? "WasmerShell")
    }
  }
  static var initial: Self {
    let arguments = ProcessInfo.processInfo.arguments
    if let index = arguments.firstIndex(of: "--storage"), index + 1 < arguments.count,
       let value = Self(rawValue: arguments[index + 1]) { return value }
    return Self(rawValue: UserDefaults.standard.string(forKey: "shellStorage") ?? "") ?? .native
  }
}
