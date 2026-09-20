import Foundation

private indirect enum Wire: Codable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([Wire])
  case object([String: Wire])
  init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer()
    if value.decodeNil() {
      self = .null
    } else if let v = try? value.decode(Bool.self) {
      self = .bool(v)
    } else if let v = try? value.decode(Double.self) {
      self = .number(v)
    } else if let v = try? value.decode(String.self) {
      self = .string(v)
    } else if let v = try? value.decode([Wire].self) {
      self = .array(v)
    } else {
      self = .object(try value.decode([String: Wire].self))
    }
  }
  func encode(to encoder: Encoder) throws {
    var value = encoder.singleValueContainer()
    switch self {
    case .null: try value.encodeNil()
    case .bool(let v): try value.encode(v)
    case .number(let v): try value.encode(v)
    case .string(let v): try value.encode(v)
    case .array(let v): try value.encode(v)
    case .object(let v): try value.encode(v)
    }
  }
  static func encode<T: Encodable>(_ value: T) throws -> Wire {
    try JSONDecoder().decode(Wire.self, from: JSONEncoder().encode(value))
  }
  static func integer(_ value: UInt64) throws -> Wire {
    guard value <= 9_007_199_254_740_991 else {
      throw SdkError.Failure(
        code: "INVALID_ARGUMENT", message: "Value exceeds JavaScript's exact integer range")
    }
    return .number(Double(value))
  }
  static func optional(_ value: UInt64?) throws -> Wire { try value.map(integer) ?? .null }
  static func handle(_ value: Int) -> Wire { .number(Double(value)) }
}
private struct WireError: Decodable {
  let code: String
  let message: String
}
private enum Reply<T: Decodable>: Decodable {
  case value(T)
  case error(WireError)
  enum Keys: CodingKey { case value, error }
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: Keys.self)
    if let error = try container.decodeIfPresent(WireError.self, forKey: .error) {
      self = .error(error)
    } else {
      self = .value(try container.decode(T.self, forKey: .value))
    }
  }
}

@available(macOS 14.0, iOS 27.0, *)
private actor WebKitClient {
  let options: ClientOptions
  private var transport: WebKitTransport?
  private var starting: Task<WebKitTransport, Error>?
  private var closed = false
  private var exposures: [Int: [GuestHTTPServer]] = [:]
  private var closedSandboxes: Set<Int> = []
  init(options: ClientOptions) { self.options = options }
  func host() async throws -> WebKitTransport {
    guard !closed else {
      throw SdkError.Failure(code: "CLIENT_CLOSED", message: "Client is closed")
    }
    if let transport { return transport }
    let task: Task<WebKitTransport, Error>
    if let starting {
      task = starting
    } else {
      let options = self.options
      task = Task { @MainActor in
        let host = WebKitTransport(cacheDirectory: URL(fileURLWithPath: options.cacheRoot!))
        do {
          try await host.start()
          let data = try await host.request("initialize", payload: JSONEncoder().encode(options))
          switch try JSONDecoder().decode(Reply<Bool>.self, from: data) {
          case .value: return host
          case .error(let error): throw SdkError.Failure(code: error.code, message: error.message)
          }
        } catch {
          await host.close()
          throw error
        }
      }
      starting = task
    }
    do {
      let host = try await task.value
      guard !closed else {
        await host.close()
        throw SdkError.Failure(code: "CLIENT_CLOSED", message: "Client is closed")
      }
      transport = host
      starting = nil
      return host
    } catch {
      starting = nil
      throw error
    }
  }
  func call<T: Decodable & Sendable>(
    _ method: String, _ args: [String: Wire] = [:], as: T.Type = T.self
  ) async throws -> T {
    try Task.checkCancellation()
    let host = try await host()
    try Task.checkCancellation()
    let data = try await host.request(method, payload: JSONEncoder().encode(args))
    let reply: Reply<T>
    do { reply = try JSONDecoder().decode(Reply<T>.self, from: data) } catch {
      throw SdkError.Failure(
        code: "INTERNAL_ERROR", message: "Invalid \(method) response: \(error)")
    }
    switch reply {
    case .value(let value): return value
    case .error(let error):
      if error.code == "CANCELLED" { throw CancellationError() }
      throw SdkError.Failure(code: error.code, message: error.message)
    }
  }
  func close() async {
    closed = true
    starting?.cancel()
    for servers in exposures.values { for server in servers { server.stop() } }
    exposures.removeAll()
    if let transport { await transport.close() }
    transport = nil
  }
  func ownExposure(_ server: GuestHTTPServer, sandbox: Int) throws {
    guard !closed, !closedSandboxes.contains(sandbox) else {
      server.stop()
      throw SdkError.Failure(code: "SANDBOX_CLOSED", message: "Sandbox is closed")
    }
    exposures[sandbox, default: []].append(server)
  }
  func closeExposures(_ sandbox: Int) {
    closedSandboxes.insert(sandbox)
    for server in exposures.removeValue(forKey: sandbox) ?? [] { server.stop() }
  }
  func register(_ mounts: [HostMount]) async throws -> [Wire] {
    let host = try await host()
    var ids: [Int] = []
    do {
      var result: [Wire] = []
      for mount in mounts {
        let id = try await host.registerMount(directory: mount.directory, readOnly: mount.readOnly)
        ids.append(id)
        result.append(
          .object([
            "id": .handle(id), "path": .string(mount.path), "readOnly": .bool(mount.readOnly),
          ]))
      }
      return result
    } catch {
      await host.removeMounts(ids)
      throw error
    }
  }
  func removeMounts(_ ids: [Int]) async { await transport?.removeMounts(ids) }
  func diagnostics() async -> BackendDiagnostics {
    guard let transport else {
      return BackendDiagnostics(webViewAttached: false, nativeOperations: 0, network: nil)
    }
    return await BackendDiagnostics(
      webViewAttached: transport.isWebViewAttached,
      nativeOperations: transport.nativeOperationCount, network: transport.nativeNetworkStats)
  }
}

public enum WorkspaceStorage: Sendable {
  case memory
  case native(URL)
  case opfs(String)
}

public struct HostMount: Sendable {
  public let path: String
  public let directory: URL
  public let readOnly: Bool
  public init(path: String, directory: URL, readOnly: Bool) {
    self.path = path
    self.directory = directory
    self.readOnly = readOnly
  }
}
public struct BackendDiagnostics: Sendable, Codable {
  public let webViewAttached: Bool
  public let nativeOperations: Int
  public let network: NativeNetworkStats?
}
private struct PackageValue: Decodable, Sendable {
  let handle: Int
  let id: String
  let commands: [String]
  let entrypoint: String?
}
private enum Source: Sendable {
  case registry(String)
  case bytes(Data)
  case definition(PackageDefinition)
}

@available(macOS 14.0, iOS 27.0, *)
public final class WasmerCore: Sendable {
  private let client: WebKitClient
  public init(options: ClientOptions) throws {
    guard let cache = options.cacheRoot else {
      throw SdkError.Failure(code: "INVALID_ARGUMENT", message: "Cache directory is required")
    }
    _ = try Wire.optional(options.outputBytes)
    try FileManager.default.createDirectory(atPath: cache, withIntermediateDirectories: true)
    client = WebKitClient(options: options)
  }
  public func createPackage(definition: PackageDefinition) async throws -> PackageCore {
    guard case .object(let args) = try Wire.encode(definition) else { preconditionFailure() }
    let value: PackageValue = try await client.call("package.create", args)
    return PackageCore(client: client, value: value, source: .definition(definition))
  }
  public func loadPackageRegistry(specifier: String) async throws -> PackageCore {
    let value: PackageValue = try await client.call("package.load", ["source": .string(specifier)])
    return PackageCore(client: client, value: value, source: .registry(value.id))
  }
  public func loadPackageBytes(bytes: Data) async throws -> PackageCore {
    let value: PackageValue = try await client.call(
      "package.bytes", ["bytes": .string(bytes.base64EncodedString())])
    return PackageCore(client: client, value: value, source: .bytes(bytes))
  }
  public func loadPackagePath(path: String) async throws -> PackageCore {
    var directory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &directory) else {
      throw SdkError.Failure(
        code: "PACKAGE_LOAD_FAILED", message: "Package file does not exist: \(path)")
    }
    guard !directory.boolValue else {
      throw SdkError.Failure(
        code: "CAPABILITY_UNAVAILABLE",
        message:
          "WebKit cannot load a local package directory. Pass a WEBC/Wasm file or use packages.create(PackageDefinition)."
      )
    }
    do {
      return try await loadPackageBytes(bytes: Data(contentsOf: URL(fileURLWithPath: path)))
    } catch let error as SdkError { throw error } catch {
      throw SdkError.Failure(code: "PACKAGE_LOAD_FAILED", message: error.localizedDescription)
    }
  }
  fileprivate func owned(_ package: PackageCore) async throws -> PackageCore {
    if package.client === client { return package }
    switch package.source {
    case .registry(let source): return try await loadPackageRegistry(specifier: source)
    case .bytes(let bytes): return try await loadPackageBytes(bytes: bytes)
    case .definition(let definition): return try await createPackage(definition: definition)
    }
  }
  public func createSandbox(
    packages: [PackageCore], files: [String: Data], env: [String: String], network: NetworkMode,
    storage: WorkspaceStorage = .memory, mounts: [HostMount] = []
  ) async throws -> SandboxCore {
    guard !mounts.contains(where: { $0.path == "/workspace" }) else {
      throw SdkError.Failure(code: "INVALID_ARGUMENT", message: "Use storage to configure /workspace")
    }
    var handles: [Wire] = []
    for package in packages { handles.append(.handle(try await owned(package).value.handle)) }
    var allMounts = mounts
    let storageWire: Wire
    switch storage {
    case .memory: storageWire = .object(["kind": .string("memory")])
    case .native(let directory):
      allMounts.append(HostMount(path: "/workspace", directory: directory, readOnly: false))
      storageWire = .object(["kind": .string("native")])
    case .opfs(let volume):
      guard !volume.isEmpty, volume.utf8.count <= 128,
        volume.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_ ")).contains($0) })
      else { throw SdkError.Failure(code: "INVALID_ARGUMENT", message: "OPFS volume must be a short name containing letters, numbers, spaces, - or _") }
      storageWire = .object(["kind": .string("opfs"), "volume": .string(volume)])
    }
    let registered = try await client.register(allMounts)
    let ids = registered.compactMap { value -> Int? in
      guard case .object(let mount) = value, case .number(let id) = mount["id"] else { return nil }
      return Int(id)
    }
    do {
      let handle: Int = try await client.call(
        "sandbox.create",
        [
          "packages": .array(handles), "files": try Wire.encode(files),
          "env": try Wire.encode(env), "network": .string(network.rawValue),
          "mounts": .array(registered), "storage": storageWire,
        ])
      return SandboxCore(owner: self, client: client, handle: handle, mounts: ids)
    } catch {
      await client.removeMounts(ids)
      throw error
    }
  }
  public func close() async throws { await client.close() }
  public func diagnostics() async -> BackendDiagnostics { await client.diagnostics() }
}

@available(macOS 14.0, iOS 27.0, *)
public final class PackageCore: Sendable {
  fileprivate let client: WebKitClient
  fileprivate let value: PackageValue
  fileprivate let source: Source
  fileprivate init(client: WebKitClient, value: PackageValue, source: Source) {
    self.client = client
    self.value = value
    self.source = source
  }
  public func id() -> String { value.id }
  public func commands() -> [String] { value.commands }
  public func entrypoint() -> String? { value.entrypoint }
  public func command(name: String) throws -> CommandRefCore {
    guard value.commands.contains(name) else {
      throw SdkError.Failure(code: "COMMAND_NOT_FOUND", message: "Package does not export \(name)")
    }
    return CommandRefCore(package: self, name: name)
  }
}
@available(macOS 14.0, iOS 27.0, *)
public final class CommandRefCore: Sendable {
  fileprivate let package: PackageCore
  private let commandName: String
  fileprivate init(package: PackageCore, name: String) {
    self.package = package
    commandName = name
  }
  public func name() -> String { commandName }
}

@available(macOS 14.0, iOS 27.0, *)
public final class SandboxCore: Sendable {
  fileprivate let owner: WasmerCore
  fileprivate let client: WebKitClient
  fileprivate let handle: Int
  private let mounts: [Int]
  fileprivate init(owner: WasmerCore, client: WebKitClient, handle: Int, mounts: [Int]) {
    self.owner = owner
    self.client = client
    self.handle = handle
    self.mounts = mounts
  }
  public func commandName(name: String, args: [String], cwd: String?, env: [String: String])
    -> CommandCore
  {
    CommandCore(sandbox: self, selector: .name(name), args: args, cwd: cwd, env: env)
  }
  public func commandPackage(
    package: PackageCore, args: [String], cwd: String?, env: [String: String]
  ) -> CommandCore {
    CommandCore(sandbox: self, selector: .package(package), args: args, cwd: cwd, env: env)
  }
  public func commandRef(
    reference: CommandRefCore, args: [String], cwd: String?, env: [String: String]
  ) -> CommandCore {
    CommandCore(sandbox: self, selector: .reference(reference), args: args, cwd: cwd, env: env)
  }
  public func installPackageRegistry(specifier: String) async throws -> PackageCore {
    try await installPackageRef(package: owner.loadPackageRegistry(specifier: specifier))
  }
  public func installPackagePath(path: String) async throws -> PackageCore {
    try await installPackageRef(package: owner.loadPackagePath(path: path))
  }
  public func installPackageBytes(bytes: Data) async throws -> PackageCore {
    try await installPackageRef(package: owner.loadPackageBytes(bytes: bytes))
  }
  public func installPackageRef(package: PackageCore) async throws -> PackageCore {
    let owned = try await owner.owned(package)
    let value: PackageValue = try await client.call(
      "sandbox.install", ["sandbox": .handle(handle), "package": .handle(owned.value.handle)])
    return PackageCore(client: client, value: value, source: owned.source)
  }
  public func filesystem() -> FileSystemCore { FileSystemCore(sandbox: self) }
  public func ports() -> PortsCore { PortsCore(sandbox: self) }
  public func close() async throws {
    await client.closeExposures(handle)
    let _: Bool = try await client.call("sandbox.close", ["sandbox": .handle(handle)])
    await client.removeMounts(mounts)
  }
}

@available(macOS 14.0, iOS 27.0, *)
public final class CommandCore: Sendable {
  fileprivate enum Selector: Sendable {
    case name(String)
    case package(PackageCore)
    case reference(CommandRefCore)
  }
  private let sandbox: SandboxCore
  private let selector: Selector
  private let args: [String]
  private let cwd: String?
  private let env: [String: String]
  fileprivate init(
    sandbox: SandboxCore, selector: Selector, args: [String], cwd: String?, env: [String: String]
  ) {
    self.sandbox = sandbox
    self.selector = selector
    self.args = args
    self.cwd = cwd
    self.env = env
  }
  private func payload(timeout: UInt64?, output: UInt64?) async throws -> [String: Wire] {
    let selected: [String: Wire]
    switch selector {
    case .name(let name): selected = ["kind": .string("name"), "name": .string(name)]
    case .package(let package):
      selected = [
        "kind": .string("package"),
        "package": .handle(try await sandbox.owner.owned(package).value.handle),
      ]
    case .reference(let reference):
      selected = [
        "kind": .string("reference"),
        "package": .handle(try await sandbox.owner.owned(reference.package).value.handle),
        "name": .string(reference.name()),
      ]
    }
    return [
      "sandbox": .handle(sandbox.handle), "selector": .object(selected),
      "args": try Wire.encode(args),
      "cwd": cwd.map(Wire.string) ?? .null, "env": try Wire.encode(env),
      "timeoutMs": try Wire.optional(timeout), "outputBytes": try Wire.optional(output),
    ]
  }
  public func run(options: RunOptions) async throws -> ProcessOutput {
    var args = try await payload(timeout: options.timeoutMs, output: options.outputBytes)
    args["input"] = options.input.map { .string($0.base64EncodedString()) } ?? .null
    return try await sandbox.client.call("command.run", args)
  }
  public func spawn(
    options: SpawnOptions, terminalColumns: UInt32? = nil, terminalRows: UInt32? = nil
  ) async throws -> ProcessCore {
    var args = try await payload(timeout: options.timeoutMs, output: options.outputBytes)
    args["stdin"] = .string(options.stdin.rawValue)
    args["stdout"] = .string(options.stdout.rawValue)
    args["stderr"] = .string(options.stderr.rawValue)
    if let columns = terminalColumns, let rows = terminalRows {
      args["terminal"] = .object([
        "columns": .number(Double(columns)), "rows": .number(Double(rows)),
      ])
    }
    let value: ProcessValue = try await sandbox.client.call("command.spawn", args)
    return ProcessCore(
      client: sandbox.client, value: value, stdin: terminalColumns != nil || options.stdin == .pipe,
      stdout: terminalColumns != nil || options.stdout == .pipe,
      stderr: terminalColumns != nil || options.stderr == .pipe)
  }
}
private struct ProcessValue: Decodable, Sendable {
  let handle: Int
  let id: UInt32
}
@available(macOS 14.0, iOS 27.0, *)
public final class ProcessCore: Sendable {
  private let client: WebKitClient
  private let value: ProcessValue
  private let input: Bool
  private let output: Bool
  private let error: Bool
  fileprivate init(
    client: WebKitClient, value: ProcessValue, stdin: Bool, stdout: Bool, stderr: Bool
  ) {
    self.client = client
    self.value = value
    input = stdin
    output = stdout
    error = stderr
  }
  deinit {
    let client = client
    let handle = value.handle
    Task { let _: Bool? = try? await client.call("process.release", ["process": .handle(handle)]) }
  }
  public func id() -> UInt32 { value.id }
  public func hasStdin() -> Bool { input }
  public func hasStdout() -> Bool { output }
  public func hasStderr() -> Bool { error }
  private func call<T: Decodable & Sendable>(
    _ method: String, _ args: [String: Wire] = [:], as: T.Type = T.self
  ) async throws -> T {
    try await client.call(
      "process." + method, args.merging(["process": .handle(value.handle)]) { _, rhs in rhs })
  }
  public func writeStdin(bytes: Data) async throws {
    for offset in stride(from: 0, to: bytes.count, by: 65536) {
      let chunk = bytes.subdata(in: offset..<min(bytes.count, offset + 65536))
      let _: Bool = try await call("write", ["bytes": .string(chunk.base64EncodedString())])
    }
  }
  public func closeStdin() async throws { let _: Bool = try await call("closeStdin") }
  private func read(_ stderr: Bool, _ maximum: UInt64) async throws -> Data? {
    guard maximum > 0 else {
      throw SdkError.Failure(code: "INVALID_ARGUMENT", message: "maxBytes must be positive")
    }
    return try await call(
      "read", ["stderr": .bool(stderr), "maxBytes": try Wire.integer(min(maximum, 65536))])
  }
  public func readStdout(maxBytes: UInt64) async throws -> Data? { try await read(false, maxBytes) }
  public func readStderr(maxBytes: UInt64) async throws -> Data? { try await read(true, maxBytes) }
  public func wait() async throws -> ProcessOutput { try await call("wait") }
  public func terminate(graceMs: UInt64) async throws {
    let _: Bool = try await call("terminate", ["graceMs": try Wire.integer(graceMs)])
  }
  public func kill() { Task { let _: Bool? = try? await call("kill") } }
  public func resizeTerminal(columns: UInt32, rows: UInt32) async throws {
    let _: Bool = try await call(
      "resize", ["columns": .number(Double(columns)), "rows": .number(Double(rows))])
  }
}

@available(macOS 14.0, iOS 27.0, *)
public final class FileSystemCore: Sendable {
  private let sandbox: SandboxCore
  fileprivate init(sandbox: SandboxCore) { self.sandbox = sandbox }
  private func call<T: Decodable & Sendable>(
    _ method: String, _ args: [String: Wire], as: T.Type = T.self
  ) async throws -> T {
    try await sandbox.client.call(
      "fs." + method, args.merging(["sandbox": .handle(sandbox.handle)]) { _, rhs in rhs })
  }
  public func write(path: String, bytes: Data) async throws {
    let _: Bool = try await call(
      "write", ["path": .string(path), "bytes": .string(bytes.base64EncodedString())])
  }
  public func read(path: String) async throws -> Data {
    try await call("read", ["path": .string(path)])
  }
  public func mkdir(path: String, recursive: Bool) async throws {
    let _: Bool = try await call("mkdir", ["path": .string(path), "recursive": .bool(recursive)])
  }
  public func readDir(path: String) async throws -> [DirectoryEntry] {
    try await call("readDir", ["path": .string(path)])
  }
  public func stat(path: String) async throws -> FileStat {
    try await call("stat", ["path": .string(path)])
  }
  public func remove(path: String, recursive: Bool) async throws {
    let _: Bool = try await call("remove", ["path": .string(path), "recursive": .bool(recursive)])
  }
  public func rename(from: String, to: String) async throws {
    let _: Bool = try await call("rename", ["from": .string(from), "to": .string(to)])
  }
}
@available(macOS 14.0, iOS 27.0, *)
public final class PortsCore: Sendable {
  private let sandbox: SandboxCore
  fileprivate init(sandbox: SandboxCore) { self.sandbox = sandbox }
  public func wait(port: UInt16, timeoutMs: UInt64) async throws {
    let _: Bool = try await sandbox.client.call(
      "ports.wait",
      [
        "sandbox": .handle(sandbox.handle), "port": .number(Double(port)),
        "timeoutMs": try Wire.integer(timeoutMs),
      ])
  }
  public func listening() async throws -> [UInt16]? {
    try await sandbox.client.call("ports.list", ["sandbox": .handle(sandbox.handle)])
  }
  public func request(port: UInt16, request: GuestHTTPRequest) async throws -> GuestHTTPResponse {
    try await sandbox.client.call(
      "ports.request",
      [
        "sandbox": .handle(sandbox.handle), "port": .number(Double(port)),
        "method": .string(request.method), "path": .string(request.path),
        "headers": try Wire.encode(request.headers),
        "body": .string(request.body.base64EncodedString()),
      ])
  }
  public func expose(port: UInt16) async throws -> ExposedPortCore {
    try await wait(port: port, timeoutMs: 30_000)
    let server = GuestHTTPServer { request in try await self.request(port: port, request: request) }
    do {
      let url = try await server.start()
      try await sandbox.client.ownExposure(server, sandbox: sandbox.handle)
      return ExposedPortCore(url: url, server: server)
    } catch {
      server.stop()
      throw error
    }
  }
}
public final class ExposedPortCore: Sendable {
  public let url: URL
  private let server: GuestHTTPServer
  fileprivate init(url: URL, server: GuestHTTPServer) {
    self.url = url
    self.server = server
  }
  public func close() { server.stop() }
  deinit { server.stop() }
}
