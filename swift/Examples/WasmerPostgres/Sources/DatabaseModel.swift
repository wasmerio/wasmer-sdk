import Foundation
import PostgresNIO
import SwiftUI
import WasmerSDK

struct QueryResult: Sendable {
  var columns: [String] = []
  var rows: [[String]] = []
  var totalRows = 0
  var seconds = 0.0
}

@MainActor
final class DatabaseModel: ObservableObject {
  @Published var status = "Starting PostgreSQL"
  @Published var progress: Double?
  @Published var ready = false
  @Published var busy = false
  @Published var sql = "SELECT version();"
  @Published var result: QueryResult?
  @Published var error: String?
  @Published var history: [String] = []
  @Published var log = ""

  private var wasmer: Wasmer?
  private var sandbox: Sandbox?
  private var process: WasmerSDK.Process?
  private var forwarding: TCPPortForward?
  private var connection: PostgresConnection?
  private var stderrTask: Task<Void, Never>?
  private var processTask: Task<Void, Never>?
  private var session = UUID()
  private var activeQuery: QueryCompletion?

  func start() async {
    guard !busy, !ready else { return }
    busy = true
    error = nil
    do {
      try await open()
      if CommandLine.arguments.contains("--self-test") {
        try await selfTest()
      }
      result = try await query(PostgresQuery(unsafeSQL: sql))
    } catch {
      self.error = Self.message(error)
      status = "Could not start PostgreSQL"
      appendLog("ERROR: \(String(reflecting: error))")
      if CommandLine.arguments.contains("--self-test") { writeTestResult(passed: false, detail: self.error!) }
      await close()
    }
    busy = false
  }

  private func open() async throws {
    status = "Loading wasmer/pglite"
    let wasmer = try Wasmer()
    self.wasmer = wasmer
    let source: PackageSource
    if let localPackage = Bundle.main.url(forResource: "pglite", withExtension: "webc") {
      source = .file(localPackage)
      appendLog("Using the locally rebuilt PGlite package")
    } else { source = .registry("wasmer/pglite@0.1.3") }
    let package = try await wasmer.packages.load(source, onProgress: { [weak self] update in
      Task { @MainActor in self?.progress = update.download.percent.map { $0 / 100 } }
    })
    status = "Starting PostgreSQL"
    let sandbox = try await wasmer.sandboxes.create(packages: [.package(package)], network: .host)
    self.sandbox = sandbox
    let process = try await sandbox.command(package).spawn(stdout: .capture, stderr: .pipe)
    self.process = process
    let session = self.session
    processTask = Task { [weak self] in
      do {
        let output = try await process.wait()
        guard let self, self.session == session else { return }
        self.appendLog("PostgreSQL exited: \(output.exitCode) (\(output.reason))")
        self.activeQuery?.finish(.failure(DemoError.failed("PostgreSQL exited (\(output.exitCode))")))
        self.forwarding?.close()
        if self.ready {
          self.ready = false
          self.status = "PostgreSQL stopped"
        }
      } catch {
        guard let self, self.session == session else { return }
        self.appendLog("Process wait: \(error)")
        self.activeQuery?.finish(.failure(error))
        self.forwarding?.close()
        self.ready = false
        self.status = "PostgreSQL stopped · Reset to reconnect"
        self.error = "PostgreSQL stopped: \(Self.message(error))"
        // Force pending client operations to fail when the guest traps.
        if let connection = self.connection { try? await connection.close() }
      }
    }
    stderrTask = Task { [weak self] in
      do {
        if let stream = process.stderr {
          for try await bytes in stream { self?.appendLog(String(decoding: bytes, as: UTF8.self)) }
        }
      } catch { self?.appendLog("Process output: \(error)") }
    }
    // This observes the listener without opening a connection. PGlite accepts
    // one client, so a native TCP readiness probe would consume that client.
    let forwarding = try await sandbox.ports.forwardTCP(5432)
    self.forwarding = forwarding
    status = "Connecting Swift client"
    connection = try await PostgresConnection.connect(
      configuration: .init(host: forwarding.host, port: Int(forwarding.port),
                           username: "postgres", password: nil, database: "postgres", tls: .disable),
      id: 1, logger: .init(label: "io.wasmer.postgres")
    )
    // Keep a single connection for the entire session: the package exits when
    // its client disconnects. A connection pool would not match this runtime.
    _ = try await query("SET statement_timeout = '15s'")
    ready = true
    status = "PostgreSQL 18.4 · Connected"
    appendLog("Swift PostgresNIO connected to PostgreSQL inside Wasmer.")
  }

  func run() async {
    guard ready, !busy, !sql.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    busy = true
    error = nil
    result = nil
    let statement = sql
    do {
      result = try await query(PostgresQuery(unsafeSQL: statement))
      history.removeAll { $0 == statement }
      history.insert(statement, at: 0)
      history = Array(history.prefix(20))
    } catch { self.error = Self.message(error) }
    busy = false
  }

  func reset() async {
    guard !busy else { return }
    busy = true
    await close()
    result = nil
    busy = false
    await start()
  }

  func restartForTest() async throws {
    await close()
    try await open()
  }

  func isWebViewDetached() async -> Bool {
    guard let wasmer else { return false }
    return await !wasmer.diagnostics().webViewAttached
  }

  private func close() async {
    ready = false
    session = UUID()
    activeQuery?.finish(.failure(CancellationError()))
    forwarding?.close(); forwarding = nil
    process?.kill(); process = nil
    // Closing the owner also interrupts pending RPCs if a guest trapped.
    if let wasmer { try? await wasmer.close() }
    wasmer = nil
    if let connection { try? await connection.close() }
    connection = nil
    sandbox = nil
    stderrTask?.cancel(); stderrTask = nil
    processTask?.cancel(); processTask = nil
  }

  func query(_ query: PostgresQuery) async throws -> QueryResult {
    guard let connection, !connection.isClosed else { throw DemoError.failed("No database connection") }
    let completion = QueryCompletion()
    activeQuery = completion
    defer { activeQuery = nil }
    return try await withCheckedThrowingContinuation { continuation in
      completion.continuation = continuation
      completion.operation = Task {
        do { completion.finish(.success(try await self.readResult(query, connection: connection))) }
        catch { completion.finish(.failure(error)) }
      }
      completion.deadline = Task {
        do { try await Task.sleep(for: .seconds(20)) } catch { return }
        self.appendLog("Query timed out; closing the session")
        self.ready = false
        self.status = "Query timed out · Reset to reconnect"
        completion.finish(.failure(DemoError.failed("Query timed out. Reset to reconnect.")))
        await Task { await self.close() }.value
      }
    }
  }

  private func readResult(_ query: PostgresQuery, connection: PostgresConnection) async throws -> QueryResult {
    let started = Date()
    let sequence = try await connection.query(query, logger: .init(label: "io.wasmer.postgres"))
    var result = QueryResult()
    for try await row in sequence {
      if result.columns.isEmpty { result.columns = row.map(\.columnName) }
      if result.rows.count < 100 { result.rows.append(row.map(Self.display)) }
      result.totalRows += 1
    }
    result.seconds = Date().timeIntervalSince(started)
    return result
  }

  private static func display(_ cell: PostgresCell) -> String {
    guard let bytes = cell.bytes else { return "NULL" }
    let value: String
    switch cell.dataType {
    case .int2, .int4, .int8: value = (try? cell.decode(Int64.self)).map { String($0) } ?? "?"
    case .bool: value = (try? cell.decode(Bool.self)).map { String($0) } ?? "?"
    case .float4, .float8: value = (try? cell.decode(Double.self)).map { String($0) } ?? "?"
    case .text, .varchar, .bpchar, .name, .json:
      value = String(decoding: bytes.readableBytesView, as: UTF8.self)
    case .jsonb: value = String(decoding: bytes.readableBytesView.dropFirst(), as: UTF8.self)
    case .uuid: value = (try? cell.decode(UUID.self))?.uuidString ?? "?"
    case .timestamp, .timestamptz, .date: value = (try? cell.decode(Date.self))?.description ?? "?"
    default: value = "\(cell.dataType): " + bytes.readableBytesView.prefix(64).map { String(format: "%02x", $0) }.joined()
    }
    return value.count > 4_000 ? String(value.prefix(4_000)) + "…" : value
  }

  private static func message(_ error: Error) -> String {
    if let error = error as? PSQLError, let server = error.serverInfo {
      return server[.message] ?? String(reflecting: error)
    }
    return String(describing: error)
  }

  func appendLog(_ line: String) {
    log = String((log + line + "\n").suffix(32_000))
    print(line)
    try? log.write(to: Self.documents.appendingPathComponent("postgres.log"), atomically: true, encoding: .utf8)
  }

  static var documents: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }

  enum DemoError: Error { case failed(String) }
}

/// A guest trap can leave a PostgreSQL request without ReadyForQuery. Do not
/// require that request to finish before reporting the process failure to UI.
@MainActor
private final class QueryCompletion {
  var continuation: CheckedContinuation<QueryResult, Error>?
  var operation: Task<Void, Never>?
  var deadline: Task<Void, Never>?
  func finish(_ result: Result<QueryResult, Error>) {
    guard let continuation else { return }
    self.continuation = nil
    operation?.cancel(); operation = nil
    deadline?.cancel(); deadline = nil
    continuation.resume(with: result)
  }
}
