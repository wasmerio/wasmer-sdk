import Foundation
import Testing
import WasmerSDK

private func withSandbox(
  _ body: (Wasmer, Sandbox, Package) async throws -> Void
) async throws {
  let cache = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  defer { try? FileManager.default.removeItem(at: cache) }
  let client = try Wasmer(cacheDirectory: cache)
  let fixture = try #require(Bundle.module.url(forResource: "Fixtures", withExtension: nil))
  let package = try await client.packages.load(.file(fixture))
  let sandbox = try await client.sandboxes.create(packages: [.package(package)])
  do {
    try await body(client, sandbox, package)
  } catch {
    try? await sandbox.close()
    try? await client.close()
    throw error
  }
  try await sandbox.close()
  try await client.close()
}

@Test func capturedCommandsAndPackageSelectors() async throws {
  try await withSandbox { _, sandbox, package in
    // Local packages use a content hash; registry packages use name@version.
    #expect(package.id.hasPrefix("sha256:"))
    #expect(Set(package.commands) == ["hello", "fail", "echo"])
    #expect(package.entrypoint == "hello")
    let reference = try package.command("hello")
    let commands = [sandbox.command("hello"), sandbox.command(package), sandbox.command(reference)]
    for command in commands {
      let output = try await command.run(timeout: 10)
      #expect(try output.text() == "Hello from Swift!\n")
      #expect(output.reason == .exited)
      #expect(output.stderr.isEmpty)
    }
    let output = try await commands[0].run()
    #expect(output.ok)
  }
}

@Test func filesAndErrorsCrossTheFFI() async throws {
  try await withSandbox { _, sandbox, _ in
    try await sandbox.fs.mkdir("nested")
    try await sandbox.fs.writeText("nested/original", "Swift 🦀")
    try await sandbox.fs.rename("nested/original", to: "nested/renamed")
    #expect(try await sandbox.fs.readText("nested/renamed") == "Swift 🦀")
    #expect(try await sandbox.fs.stat("nested/renamed").kind == .file)
    #expect(try await sandbox.fs.readDir("nested").map(\.name) == ["renamed"])
    try await sandbox.fs.write("invalid", Data([0xff]))
    await #expect(throws: WasmerError.self) { try await sandbox.fs.readText("invalid") }
    try await sandbox.fs.remove("nested", recursive: true)
    await #expect(throws: WasmerError.self) { try await sandbox.fs.read("nested/renamed") }
  }
}

@Test func failuresAndTruncation() async throws {
  try await withSandbox { _, sandbox, _ in
    do {
      _ = try await sandbox.command("fail").run()
      Issue.record("An unsuccessful run should throw")
    } catch let error as ProcessExitError {
      #expect(error.output.exitCode == 7)
      #expect(String(decoding: error.output.stderr, as: UTF8.self) == "intentional failure\n")
    }
    let unchecked = try await sandbox.command("fail").run(check: false)
    #expect(unchecked.exitCode == 7)
    #expect(!unchecked.ok)
    let short = try await sandbox.command("hello").run(outputBytes: 5)
    #expect(short.stdout == Data("Hello".utf8))
    #expect(short.stdoutTruncated)
  }
}

@Test func liveStdinAndPullBasedOutput() async throws {
  try await withSandbox { _, sandbox, _ in
    let process = try await sandbox.command("echo").spawn(
      stdin: .pipe, stderr: .discard, timeout: 10)
    let stdin = try #require(process.stdin)
    let stdout = try #require(process.stdout)
    #expect(process.stderr == nil)
    try await stdin.write("hello from stdin\n")
    try await stdin.close()
    var bytes = Data()
    for try await chunk in stdout { bytes.append(chunk) }
    #expect(bytes == Data("hello from stdin\n".utf8))
    #expect(try await stdout.read() == nil)
    #expect(try await process.wait(check: true).ok)
    let captured = try await sandbox.command("echo").run(
      input: Data("captured stdin".utf8), timeout: 10)
    #expect(try captured.text() == "captured stdin")
  }
}

@Test func terminationAndTimeout() async throws {
  try await withSandbox { _, sandbox, _ in
    let process = try await sandbox.command("echo").spawn(
      stdin: .pipe, stdout: .discard, stderr: .discard)
    try await process.terminate(gracePeriod: 0.01)
    #expect(try await process.wait().reason == .terminated)
    let timed = try await sandbox.command("echo").spawn(
      stdin: .pipe, stdout: .discard, stderr: .discard, timeout: 0.05
    )
    #expect(try await timed.wait().reason == .timeout)
  }
}

@Test func durationValidationDoesNotTrap() async throws {
  try await withSandbox { _, sandbox, _ in
    for timeout in [-1, Double.nan, Double.infinity, Double.greatestFiniteMagnitude] {
      await #expect(throws: WasmerError.self) {
        try await sandbox.command("hello").run(timeout: timeout)
      }
    }
    await #expect(throws: WasmerError.self) { try await sandbox.ports.wait(0) }
  }
}

@Test func dynamicInstallAndClosedSandbox() async throws {
  try await withSandbox { client, _, package in
    let sandbox = try await client.sandboxes.create(files: ["seed": Data("seed".utf8)])
    #expect(try await sandbox.fs.readText("seed") == "seed")
    try await sandbox.installPackage(.package(package))
    #expect(try await sandbox.command("hello").run().ok)
    try await sandbox.close()
    await #expect(throws: WasmerError.self) { try await sandbox.command("hello").run() }
  }
}

@Test func fileURLsAreRequired() throws {
  #expect(throws: WasmerError.self) {
    try Wasmer(cacheDirectory: URL(string: "https://example.com/cache")!)
  }
}

@Test(.enabled(if: ProcessInfo.processInfo.environment["WASMER_SWIFT_INTEGRATION"] == "1"))
func registryPython() async throws {
  let client = try Wasmer()
  do {
    let sandbox = try await client.sandboxes.create(packages: ["python/python@=3.13.20"])
    do {
      let output = try await sandbox.command(
        "python", ["-c", "print('Swift and Python')"]
      ).run(timeout: 60)
      #expect(try output.text() == "Swift and Python\n")
      try await sandbox.close()
    } catch {
      try? await sandbox.close()
      throw error
    }
    try await client.close()
  } catch {
    try? await client.close()
    throw error
  }
}
