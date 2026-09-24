import Foundation
import PostgresNIO

extension DatabaseModel {
  /// Run the same Swift client and transport used by the interactive console.
  func selfTest() async throws {
    let started = Date()
    func check(_ condition: Bool, _ name: String) throws {
      guard condition else { throw DemoError.failed(name) }
      appendLog("PASS: \(name)")
    }
    try check(await isWebViewDetached(), "WKWebView stays detached from the visible UI")
    let version = try await query("SELECT version(), 6 * 7 AS answer")
    try check(version.rows.first?[0].contains("wasm32-unknown-wasix") == true && version.rows.first?[1] == "42",
              "PostgreSQL executes in WASIX and returns 42")
    _ = try await query("CREATE TABLE demo_notes (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text NOT NULL)")
    let unicode = "Hello from Swift 🐘 — café 日本語 'quoted'"
    let inserted = try await query("INSERT INTO demo_notes(body) VALUES (\(unicode)) RETURNING body")
    try check(inserted.rows.first?.first == unicode, "Parameter binding and Unicode round trip")
    _ = try await query("BEGIN")
    _ = try await query("INSERT INTO demo_notes(body) VALUES ('rolled back')")
    _ = try await query("ROLLBACK")
    let count = try await query("SELECT count(*) FROM demo_notes")
    try check(count.rows == [["1"]], "Transaction rollback")
    _ = try await query("BEGIN")
    _ = try await query("UPDATE demo_notes SET body = 'Committed from Swift' WHERE id = 1")
    _ = try await query("COMMIT")
    try check(try await query("SELECT body FROM demo_notes WHERE id = 1").rows == [["Committed from Swift"]], "Transaction commit and update")
    let json = try await query("SELECT '{\"works\":true}'::jsonb ->> 'works', NULL::text, true")
    try check(json.rows == [["true", "NULL", "true"]], "JSONB, NULL and Boolean values")
    do {
      _ = try await query("SELECT * FROM intentionally_missing_table")
      throw DemoError.failed("Expected a PostgreSQL error")
    } catch is PSQLError { appendLog("PASS: SQL error reaches Swift") }
    try check(try await query("SELECT 42").rows == [["42"]], "Connection recovers after SQL error")
    _ = try await query("BEGIN")
    do {
      _ = try await query("SELECT 1 / 0")
      throw DemoError.failed("Expected division by zero")
    } catch is PSQLError { appendLog("PASS: Executor error reaches Swift") }
    _ = try await query("ROLLBACK")
    try check(try await query("SELECT 42").rows == [["42"]], "Recover aborted transaction")
    let payload = String(repeating: "a", count: 1024 * 1024)
    try check(try await query("SELECT octet_length(\(payload)::text)").rows == [["1048576"]], "1 MiB parameter crosses bounded transport")
    let large = try await query("SELECT i, repeat('x', 2048) FROM generate_series(1, 4096) AS i")
    try check(large.totalRows == 4096 && large.rows.count == 100, "8 MiB result drains with bounded UI retention")
    for i in 0..<30 {
      let result = try await query("SELECT \(i)::integer")
      try check(result.rows == [[String(i)]], "Repeated query \(i + 1)/30")
    }
    _ = try await query("DELETE FROM demo_notes")
    try check(try await query("SELECT count(*) FROM demo_notes").rows == [["0"]], "Delete")
    _ = try await query("DROP TABLE demo_notes")
    for i in 1...2 {
      try await restartForTest()
      try check(try await query("SELECT 42").rows == [["42"]], "Reset and reconnect \(i)/2")
      try check(await isWebViewDetached(), "Web view remains detached after reset")
    }
    writeTestResult(passed: true, detail: "SQL, parameters, transactions, errors, 1 MiB upload, 8 MiB result, 30 repeated queries, 2 resets; \(Date().timeIntervalSince(started)) seconds")
    appendLog("ALL TESTS PASSED")
  }

  func writeTestResult(passed: Bool, detail: String) {
    let result: [String: Any] = ["passed": passed, "detail": detail]
    if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
      try? data.write(to: Self.documents.appendingPathComponent("test-result.json"), options: .atomic)
    }
  }
}
