import Foundation
import WasmerSDK

/// Executed unchanged by native Swift tests and the iOS simulator probe.
func runSDKContract(fixtures: URL) async throws -> [String] {
  var checks: [String] = []
  func check(_ condition: Bool, _ label: String) throws {
    guard condition else { throw ContractFailure.failed(label) }
    checks.append(label)
  }
  let cache = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  defer { try? FileManager.default.removeItem(at: cache) }
  let client = try Wasmer(cacheDirectory: cache)
  let other = try Wasmer(cacheDirectory: cache.appendingPathComponent("other"))
  do {
    let modules = try Dictionary(
      uniqueKeysWithValues: ["hello", "echo", "fail"].map {
        ($0, try Data(contentsOf: fixtures.appendingPathComponent($0 + ".wasm")))
      })
    let value = PackageDefinition(
      modules: modules,
      commands: Dictionary(uniqueKeysWithValues: modules.keys.map { ($0, .init(module: $0)) }),
      entrypoint: "hello")
    let package = try await client.packages.create(value)
    try check(
      Set(package.commands) == Set(modules.keys) && package.entrypoint == "hello",
      "package metadata")
    try check(try await client.packages.create(value).id == package.id, "content identity")
    let sandbox = try await client.sandboxes.create(
      packages: [.package(package)], files: ["seed": Data([0, 255])])
    let second = try await client.sandboxes.create()
    try await second.installPackage(.package(package))
    let imported = try await other.sandboxes.create(packages: [.package(package)])
    try check(
      try await imported.command(package).run().text() == "Hello from Swift!\n",
      "package reuse across clients")
    try await imported.close()
    try await other.close()
    let command = sandbox.command(try package.command("hello"))
    for _ in 0..<2 {
      try check(try await command.run().text() == "Hello from Swift!\n", "reusable command")
    }
    async let left = sandbox.command("hello").run()
    async let right = second.command("hello").run()
    try check(try await left.stdout == right.stdout, "concurrent sandboxes")
    let progress = ProgressRecorder()
    let raw = try await client.packages.load(modules["hello"]!, onProgress: progress.record)
    let final = progress.last
    try check(final?.phase == .ready && final?.download.downloadedBytes == 0
      && final?.download.totalBytes == 0 && final?.download.percent == 100,
      "local package final progress before return")
    let batch = try await client.packages.loadMany([.package(raw), .bytes(modules["hello"]!)], onProgress: progress.record)
    try check(batch.count == 2 && batch[0].id == batch[1].id, "batch package order")
    let empty = try await client.packages.loadMany([], onProgress: progress.record)
    try check(empty.isEmpty && progress.last?.phase == .ready, "empty batch progress")
    let cancelled = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      return try await client.packages.load(modules["hello"]!)
    }
    do { _ = try await cancelled.value; throw ContractFailure.failed("cancelled package load") }
    catch is CancellationError { checks.append("cancelled package load") }
    try check(raw.commands == ["main"] && raw.entrypoint == "main", "raw Wasm package")
    try await sandbox.installPackage(.package(raw))
    try check(try await sandbox.command(raw).run().ok, "package selector")
    try check(try await sandbox.fs.read("seed") == Data([0, 255]), "binary file seed")
    try await sandbox.fs.mkdir("nested")
    try await sandbox.fs.writeText("nested/a", "Swift 🦀")
    try await sandbox.fs.rename("nested/a", to: "nested/b")
    try check(try await sandbox.fs.readText("nested/b") == "Swift 🦀", "filesystem rename and UTF-8")
    try check(try await sandbox.fs.stat("nested/b").kind == .file, "file stat")
    try check(try await sandbox.fs.readDir("nested").map(\.name) == ["b"], "directory entries")
    try await sandbox.fs.remove("nested", recursive: true)
    let fail = try await sandbox.command("fail").run(check: false)
    try check(fail.exitCode == 7 && !fail.ok, "unchecked exit")
    do {
      _ = try await sandbox.command("fail").run()
      throw ContractFailure.failed("checked exit")
    } catch let error as ProcessExitError { try check(error.output.exitCode == 7, "checked exit") }
    let truncated = try await command.run(outputBytes: 5)
    try check(
      truncated.stdout == Data("Hello".utf8) && truncated.stdoutTruncated, "output truncation")
    let echo = try await sandbox.command("echo").spawn(stdin: .pipe, stderr: .discard, timeout: 10)
    try check(echo.stdin != nil && echo.stdout != nil && echo.stderr == nil, "stdio modes")
    try await echo.stdin!.write("streamed input")
    try await echo.stdin!.close()
    var bytes = Data()
    for try await chunk in echo.stdout! { bytes.append(chunk) }
    try check(bytes == Data("streamed input".utf8), "streamed stdin/stdout")
    try check(try await echo.stdout!.read() == nil, "stream EOF")
    try check(try await echo.wait(check: true).ok, "process wait")
    try check(
      try await sandbox.command("echo").run(input: Data("captured".utf8)).text() == "captured",
      "captured stdin")
    let timed = try await sandbox.command("echo").spawn(
      stdin: .pipe, stdout: .discard, stderr: .discard, timeout: 0.05)
    try check(try await timed.wait().reason == .timeout, "process timeout")
    let killed = try await sandbox.command("echo").spawn(
      stdin: .pipe, stdout: .discard, stderr: .discard)
    try await killed.terminate(gracePeriod: 0.01)
    try check(try await killed.wait().reason == .terminated, "process termination")
    #if os(iOS)
      let blocked = try await sandbox.command("echo").spawn(stdin: .pipe, stderr: .discard)
      let reading = Task { try await blocked.stdout!.read() }
      try await Task.sleep(for: .milliseconds(50))
      reading.cancel()
      do {
        _ = try await reading.value
        throw ContractFailure.failed("request cancellation")
      } catch is CancellationError { checks.append("request cancellation") }
      blocked.kill()
      _ = try await blocked.wait()
      try check(try await second.command("hello").run().ok, "cancellation preserves other sandbox")
      let firstDirectory = cache.appendingPathComponent("first")
      let secondDirectory = cache.appendingPathComponent("second")
      for directory in [firstDirectory, secondDirectory] {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      }
      let python = try await client.packages.load("python/python@=3.13.20")
      let mountedA = try await client.sandboxes.create(
        packages: [.package(python)], network: .host,
        mounts: [.init("/host", directory: firstDirectory)])
      let mountedB = try await client.sandboxes.create(
        packages: [.package(python)], network: .host,
        mounts: [.init("/host", directory: secondDirectory)])
      _ = try await mountedA.command(
        "python", ["-c", "from pathlib import Path; Path('/host/file').write_text('first')"]
      ).run(timeout: 60)
      _ = try await mountedB.command(
        "python", ["-c", "from pathlib import Path; Path('/host/file').write_text('second')"]
      ).run(timeout: 60)
      try check(
        try String(contentsOf: firstDirectory.appendingPathComponent("file"), encoding: .utf8)
          == "first", "mount isolation")
      try await mountedA.close()
      try check(
        try await mountedB.command(
          "python", ["-c", "from pathlib import Path; print(Path('/host/file').read_text())"]
        ).run(timeout: 60).text() == "second\n", "independent mount lifetime")
      try check(try await mountedB.ports.listening() == [], "independent network lifetime")
      try await mountedB.close()
      do {
        _ = try await client.packages.load(.file(fixtures))
        throw ContractFailure.failed("local directory capability")
      } catch let error as WasmerError {
        try check(error.code == "CAPABILITY_UNAVAILABLE", "local directory capability")
      }
    #endif
    try await second.close()
    do {
      _ = try await second.command("hello").run()
      throw ContractFailure.failed("closed sandbox")
    } catch let error as WasmerError { try check(error.code == "SANDBOX_CLOSED", "closed sandbox") }
    try check(try await command.run().ok, "closing one sandbox preserves another")
    try await sandbox.close()
    try await client.close()
    do {
      _ = try await client.sandboxes.create()
      throw ContractFailure.failed("closed client")
    } catch let error as WasmerError { try check(error.code == "CLIENT_CLOSED", "closed client") }
    return checks
  } catch {
    try? await other.close()
    try? await client.close()
    throw error
  }
}
private enum ContractFailure: Error { case failed(String) }

private final class ProgressRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var value: PackageLoadProgress?
  func record(_ progress: PackageLoadProgress) { lock.withLock { value = progress } }
  var last: PackageLoadProgress? { lock.withLock { value } }
}
