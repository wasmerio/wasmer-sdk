import Foundation
#if os(iOS)
import WasmerWKSDK
#else
import WasmerSDKCore
#endif

public typealias WasmerError = SdkError
public typealias NetworkPolicy = NetworkMode
public typealias ExitReason = ProcessExitReason
public typealias Output = ProcessOutput

/// A registry specifier, local package directory, WEBC file, in-memory bytes,
/// or reusable package.
public enum PackageSource: Sendable, ExpressibleByStringLiteral {
  case registry(String)
  case file(URL)
  /// WEBC or raw WASI/WASIX bytes. Raw modules get the entrypoint `main`.
  case bytes(Data)
  /// Legacy spelling for in-memory package bytes.
  case webc(Data)
  case package(Package)

  public init(stringLiteral value: String) { self = .registry(value) }
}

/// A client owns a runtime, package cache, and sandbox services.
/// Keep it alive while its sandboxes are in use and explicitly close them first.
public struct Wasmer: Sendable {
  private let core: WasmerCore

  /// The default cache is in the application's Caches directory, never its bundle.
  public init(cacheDirectory: URL? = nil, outputBytes: UInt64? = nil) throws {
    let cache =
      try cacheDirectory
      ?? FileManager.default.url(
        for: .cachesDirectory, in: .userDomainMask,
        appropriateFor: nil, create: true
      ).appendingPathComponent("WasmerSDK", isDirectory: true)
    core = try WasmerCore(
      options: ClientOptions(
        cacheRoot: localPath(cache), outputBytes: outputBytes
      ))
  }

  public var packages: Packages { Packages(core: core) }
  public var sandboxes: Sandboxes { Sandboxes(core: core) }
  public func close() async throws { try await core.close() }
}

/// A WASI/WASIX command referencing a module in the same definition.
public struct PackageCommandDefinition: Sendable {
  public var module: String
  public init(module: String) { self.module = module }
}

/// In-memory module bytes and bundled files at absolute guest paths.
/// The sole command is the default entrypoint. Use the sandbox workspace for
/// persistent writes; bundled package contents are captured during creation.
public struct PackageDefinition: Sendable {
  public var modules: [String: Data]
  public var commands: [String: PackageCommandDefinition]
  public var entrypoint: String?
  public var files: [String: Data]

  public init(
    modules: [String: Data], commands: [String: PackageCommandDefinition],
    entrypoint: String? = nil, files: [String: Data] = [:]
  ) {
    self.modules = modules
    self.commands = commands
    self.entrypoint = entrypoint
    self.files = files
  }
}

public struct Packages: Sendable {
  fileprivate let core: WasmerCore

  /// Create a reusable package without serializing a WEBC archive.
  public func create(_ definition: PackageDefinition) async throws -> Package {
    let value = CorePackageDefinition(
      modules: definition.modules,
      commands: definition.commands.mapValues {
        CorePackageCommandDefinition(module: $0.module)
      },
      entrypoint: definition.entrypoint, files: definition.files
    )
    return Package(core: try await core.createPackage(definition: value))
  }

  /// Load WEBC or raw WASI/WASIX bytes. A raw module must export `_start` and
  /// gets a single command and entrypoint named `main` automatically.
  public func load(_ bytes: Data) async throws -> Package {
    return Package(core: try await core.loadPackageBytes(bytes: bytes))
  }

  public func load(_ source: PackageSource) async throws -> Package {
    switch source {
    case .registry(let specifier):
      return Package(core: try await core.loadPackageRegistry(specifier: specifier))
    case .file(let url):
      return Package(core: try await core.loadPackagePath(path: localPath(url)))
    case .bytes(let data), .webc(let data):
      return try await load(data)
    case .package(let package):
      return package
    }
  }

  public func load(_ specifier: String) async throws -> Package {
    try await load(.registry(specifier))
  }
}

public struct Package: Sendable {
  fileprivate let core: PackageCore
  public var id: String { core.id() }
  public var commands: [String] { core.commands() }
  public var entrypoint: String? { core.entrypoint() }
  public func command(_ name: String) throws -> CommandRef {
    CommandRef(core: try core.command(name: name))
  }
}

public struct CommandRef: Sendable {
  fileprivate let core: CommandRefCore
  public var name: String { core.name() }
}

/// Storage for `/workspace`, shared by guest processes and `sandbox.fs`.
public enum SandboxStorage: Sendable {
  /// Fast runtime storage, discarded when the sandbox closes.
  case memory
  /// An app-accessible directory. Currently supported by the iOS backend.
  case native(URL)
  /// A named persistent browser volume. Currently supported by the iOS backend.
  case opfs(String)
}

public struct Sandboxes: Sendable {
  fileprivate let core: WasmerCore

  public func create(
    packages: [PackageSource] = [], files: [String: Data] = [:],
    env: [String: String] = [:], network: NetworkPolicy = .disabled,
    mounts: [DirectoryMount] = [], storage: SandboxStorage = .memory
  ) async throws -> Sandbox {
    var resolved: [PackageCore] = []
    for source in packages {
      resolved.append(try await Packages(core: core).load(source).core)
    }
    #if os(iOS)
    let backendStorage: WorkspaceStorage
    switch storage {
    case .memory: backendStorage = .memory
    case .native(let directory): backendStorage = .native(URL(fileURLWithPath: try localPath(directory)))
    case .opfs(let volume): backendStorage = .opfs(volume)
    }
    return Sandbox(core: try await core.createSandbox(
      packages: resolved, files: files, env: env, network: network,
      storage: backendStorage, mounts: try mounts.map { .init(path: $0.path, directory: URL(fileURLWithPath: try localPath($0.directory)), readOnly: $0.readOnly) }))
    #else
    guard mounts.isEmpty else { throw unavailable("Native directory mounts") }
    guard case .memory = storage else { throw unavailable("External workspace storage") }
    return Sandbox(core: try await core.createSandbox(packages: resolved, files: files, env: env, network: network))
    #endif
  }
}

public struct Sandbox: Sendable {
  fileprivate let core: SandboxCore
  public var fs: SandboxFileSystem { SandboxFileSystem(core: core.filesystem()) }
  public var ports: Ports { Ports(core: core.ports()) }

  public func command(
    _ name: String, _ args: [String] = [],
    cwd: String? = nil, env: [String: String] = [:]
  ) -> Command {
    Command(core: core.commandName(name: name, args: args, cwd: cwd, env: env))
  }

  public func command(
    _ package: Package, _ args: [String] = [],
    cwd: String? = nil, env: [String: String] = [:]
  ) -> Command {
    Command(core: core.commandPackage(package: package.core, args: args, cwd: cwd, env: env))
  }

  public func command(
    _ reference: CommandRef, _ args: [String] = [],
    cwd: String? = nil, env: [String: String] = [:]
  ) -> Command {
    Command(core: core.commandRef(reference: reference.core, args: args, cwd: cwd, env: env))
  }

  @discardableResult
  public func installPackage(_ source: PackageSource) async throws -> Package {
    let package: PackageCore
    switch source {
    case .registry(let specifier):
      package = try await core.installPackageRegistry(specifier: specifier)
    case .file(let url):
      package = try await core.installPackagePath(path: localPath(url))
    case .bytes(let data), .webc(let data):
      package = try await core.installPackageBytes(bytes: data)
    case .package(let value):
      package = try await core.installPackageRef(package: value.core)
    }
    return Package(core: package)
  }

  public func close() async throws { try await core.close() }
}

public struct Command: Sendable {
  fileprivate let core: CommandCore

  /// Capture a finite command. Unsuccessful exits throw unless `check` is false.
  public func run(
    input: Data? = nil, timeout: TimeInterval? = nil,
    outputBytes: UInt64? = nil, check: Bool = true
  ) async throws -> Output {
    let output = try await core.run(
      options: RunOptions(
        input: input, timeoutMs: milliseconds(timeout), outputBytes: outputBytes
      ))
    return check ? try output.check() : output
  }

  /// Start a live process. Drain piped stdout and stderr concurrently before wait().
  public func spawn(
    stdin: InputMode = .closed, stdout: OutputMode = .pipe,
    stderr: OutputMode = .pipe, timeout: TimeInterval? = nil,
    outputBytes: UInt64? = nil, terminal: TerminalOptions? = nil
  ) async throws -> Process {
    let options = try SpawnOptions(timeoutMs: milliseconds(timeout), outputBytes: outputBytes,
      stdin: stdin, stdout: stdout, stderr: stderr)
    #if os(iOS)
    return Process(core: try await core.spawn(options: options, terminalColumns: terminal?.columns, terminalRows: terminal?.rows))
    #else
    guard terminal == nil else { throw unavailable("Terminal mode") }
    return Process(core: try await core.spawn(options: options))
    #endif
  }
}

public struct Process: Sendable {
  fileprivate let core: ProcessCore
  public var id: UInt32 { core.id() }
  public var stdin: ProcessInput? { core.hasStdin() ? ProcessInput(core: core) : nil }
  public var stdout: ProcessStream? {
    core.hasStdout() ? ProcessStream(core: core, stderr: false) : nil
  }
  public var stderr: ProcessStream? {
    core.hasStderr() ? ProcessStream(core: core, stderr: true) : nil
  }

  /// Wait is unchecked by default, including after terminate() or kill().
  public func wait(check: Bool = false) async throws -> Output {
    let output = try await core.wait()
    return check ? try output.check() : output
  }

  public func terminate(gracePeriod: TimeInterval = 1) async throws {
    try await core.terminate(graceMs: milliseconds(gracePeriod)!)
  }

  public func kill() { core.kill() }
}

public struct ProcessInput: Sendable {
  fileprivate let core: ProcessCore
  public func write(_ bytes: Data) async throws { try await core.writeStdin(bytes: bytes) }
  public func write(_ text: String) async throws { try await write(Data(text.utf8)) }
  public func close() async throws { try await core.closeStdin() }
}

/// A pull-based byte stream with backpressure. Use one reader per stream.
/// Copies share the same native stream; they do not replay earlier output.
public struct ProcessStream: AsyncSequence, Sendable {
  public typealias Element = Data
  fileprivate let core: ProcessCore
  fileprivate let stderr: Bool

  public func read(maxBytes: UInt64 = 64 * 1024) async throws -> Data? {
    try Task.checkCancellation()
    if stderr { return try await core.readStderr(maxBytes: maxBytes) }
    return try await core.readStdout(maxBytes: maxBytes)
  }

  public func makeAsyncIterator() -> AsyncIterator { AsyncIterator(stream: self) }

  public struct AsyncIterator: AsyncIteratorProtocol {
    fileprivate let stream: ProcessStream
    public mutating func next() async throws -> Data? { try await stream.read() }
  }
}

public struct SandboxFileSystem: Sendable {
  fileprivate let core: FileSystemCore
  public func write(_ path: String, _ bytes: Data) async throws {
    try await core.write(path: path, bytes: bytes)
  }
  public func writeText(_ path: String, _ text: String) async throws {
    try await write(path, Data(text.utf8))
  }
  public func read(_ path: String) async throws -> Data { try await core.read(path: path) }
  public func readText(_ path: String) async throws -> String {
    let data = try await read(path)
    return try decodeUTF8(data)
  }
  public func mkdir(_ path: String, recursive: Bool = true) async throws {
    try await core.mkdir(path: path, recursive: recursive)
  }
  public func readDir(_ path: String = ".") async throws -> [DirectoryEntry] {
    try await core.readDir(path: path)
  }
  public func stat(_ path: String) async throws -> FileStat { try await core.stat(path: path) }
  public func remove(_ path: String, recursive: Bool = false) async throws {
    try await core.remove(path: path, recursive: recursive)
  }
  public func rename(_ from: String, to: String) async throws {
    try await core.rename(from: from, to: to)
  }
}

public struct Ports: Sendable {
  fileprivate let core: PortsCore
  public func wait(_ port: UInt16, timeout: TimeInterval = 30) async throws {
    try await core.wait(port: port, timeoutMs: milliseconds(timeout)!)
  }
}

public struct ProcessExitError: Error, LocalizedError, Sendable {
  public let output: Output
  public var code: String {
    switch output.reason {
    case .timeout: return "TIMEOUT"
    case .terminated: return "PROCESS_TERMINATED"
    default: return "PROCESS_EXITED"
    }
  }
  public var errorDescription: String? {
    "Process \(output.reason) (exit code \(output.exitCode)): "
      + String(decoding: output.stderr, as: UTF8.self)
  }
}

extension SdkError {
  public var code: String {
    switch self {
    case .Failure(let code, _): return code
    }
  }
  public var message: String {
    switch self {
    case .Failure(_, let message): return message
    }
  }
}

extension ProcessOutput {
  public var ok: Bool { reason == .exited && exitCode == 0 }

  @discardableResult
  public func check() throws -> Self {
    guard ok else { throw ProcessExitError(output: self) }
    return self
  }

  /// Check the exit status and decode stdout strictly as UTF-8.
  public func text() throws -> String {
    try check()
    return try decodeUTF8(stdout)
  }
}

private func localPath(_ url: URL) throws -> String {
  guard url.isFileURL else {
    throw WasmerError.Failure(code: "INVALID_ARGUMENT", message: "Expected a local file URL")
  }
  return url.path
}

private func decodeUTF8(_ data: Data) throws -> String {
  guard let text = String(data: data, encoding: .utf8) else {
    throw WasmerError.Failure(code: "INVALID_UTF8", message: "Data is not valid UTF-8")
  }
  return text
}

/// Reject invalid values before converting floating point to an integer (which can trap).
private func milliseconds(_ seconds: TimeInterval?) throws -> UInt64? {
  guard let seconds else { return nil }
  let value = (seconds * 1_000).rounded(.up)
  guard seconds.isFinite, seconds >= 0, value < Double(UInt64.max) else {
    throw WasmerError.Failure(
      code: "INVALID_ARGUMENT",
      message: "Duration must be finite, nonnegative, and fit in UInt64 milliseconds"
    )
  }
  return UInt64(value)
}

/// Mount an app-accessible directory at an absolute guest path.
public struct DirectoryMount: Sendable {
  public let path: String
  public let directory: URL
  public let readOnly: Bool
  public init(_ path: String, directory: URL, readOnly: Bool = false) {
    self.path = path; self.directory = directory; self.readOnly = readOnly
  }
}
public struct TerminalOptions: Sendable {
  public let columns: UInt32
  public let rows: UInt32
  public init(columns: UInt32 = 80, rows: UInt32 = 24) { self.columns = columns; self.rows = rows }
}
/// Optional features vary by backend; the package/command/filesystem API is shared.
public struct Capabilities: Sendable {
  public let localPackageDirectories: Bool
  public let directoryMounts: Bool
  public let nativeStorage: Bool
  public let opfsStorage: Bool
  public let terminal: Bool
  public let httpExposure: Bool
}
extension Wasmer {
  public var capabilities: Capabilities {
    #if os(iOS)
    return Capabilities(localPackageDirectories: false, directoryMounts: true, nativeStorage: true, opfsStorage: true, terminal: true, httpExposure: true)
    #else
    return Capabilities(localPackageDirectories: true, directoryMounts: false, nativeStorage: false, opfsStorage: false, terminal: false, httpExposure: false)
    #endif
  }
  /// Diagnostic counters for integration tests, independent of the selected backend.
  public func diagnostics() async -> RuntimeDiagnostics {
    #if os(iOS)
    let value = await core.diagnostics()
    return RuntimeDiagnostics(webViewAttached: value.webViewAttached, nativeOperations: value.nativeOperations,
      network: NetworkDiagnostics(resolutions: value.network?.resolutions ?? 0, connections: value.network?.connections ?? 0,
        bytesRead: value.network?.bytesRead ?? 0, bytesWritten: value.network?.bytesWritten ?? 0, openSockets: value.network?.openSockets ?? 0))
    #else
    return RuntimeDiagnostics(webViewAttached: false, nativeOperations: 0, network: NetworkDiagnostics())
    #endif
  }
}
public struct RuntimeDiagnostics: Sendable, Codable {
  public let webViewAttached: Bool
  public let nativeOperations: Int
  public let network: NetworkDiagnostics
}
public struct NetworkDiagnostics: Sendable, Codable {
  public var resolutions = 0
  public var connections = 0
  public var bytesRead = 0
  public var bytesWritten = 0
  public var openSockets = 0
}
extension Process {
  public func resizeTerminal(columns: UInt32, rows: UInt32) async throws {
    #if os(iOS)
    try await core.resizeTerminal(columns: columns, rows: rows)
    #else
    throw unavailable("Terminal mode")
    #endif
  }
}
extension Ports {
  /// Known guest HTTP listeners; nil means the guest network lock is busy.
  public func listening() async throws -> [UInt16]? {
    #if os(iOS)
    return try await core.listening()
    #else
    throw unavailable("HTTP listener discovery")
    #endif
  }
  /// Expose a guest HTTP server through an authenticated app-local URL.
  public func expose(_ port: UInt16) async throws -> ExposedPort {
    #if os(iOS)
    return ExposedPort(core: try await core.expose(port: port))
    #else
    throw unavailable("HTTP exposure")
    #endif
  }
}
public final class ExposedPort: Sendable {
  #if os(iOS)
  private let core: ExposedPortCore
  fileprivate init(core: ExposedPortCore) { self.core = core }
  public var url: URL { core.url }
  public func close() { core.close() }
  #else
  private init(url: URL) { self.url = url }
  public let url: URL
  public func close() {}
  #endif
}
private func unavailable(_ feature: String) -> WasmerError {
  .Failure(code: "CAPABILITY_UNAVAILABLE", message: "\(feature) is not supported by this backend")
}
