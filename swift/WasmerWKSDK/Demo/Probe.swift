import Foundation
import WasmerSDK

@MainActor
func runPrototypeProbe(progress: @escaping (String) -> Void) async -> [String: Any] {
  var report: [String: Any] = ["passed": false, "package": "python/python@3.13.20",
    "osVersion": ProcessInfo.processInfo.operatingSystemVersionString]
  var runtime: Wasmer?
  do {
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let directory = documents.appendingPathComponent("WasmerWKSDKProbe")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let script = try String(contentsOf: Bundle.main.resourceURL!.appendingPathComponent("python-smoke.py"), encoding: .utf8)
    let client = try Wasmer()
    runtime = client
    progress("Checking the shared SDK API")
    report["contractChecks"] = try await runSDKContract(fixtures: Bundle.main.resourceURL!.appendingPathComponent("Fixtures"))
    progress("Loading Python")
    let sandbox = try await client.sandboxes.create(packages: ["python/python@=3.13.20"],
      mounts: [.init("/native", directory: directory), .init("/readonly", directory: directory, readOnly: true)])
    for (label, input) in [("first", "hello from native Swift\n"), ("second", "new native input after idle\n")] {
      for filename in ["python-output.json", "python-bytes.bin", "blocked.txt"] {
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(filename))
      }
      try Data(input.utf8).write(to: directory.appendingPathComponent("input.txt"))
      progress("\(label) Python run: waiting detached for 5 seconds")
      try await Task.sleep(for: .seconds(5))
      let before = await client.diagnostics().nativeOperations
      let output = try await sandbox.command("python", ["-u", "-c", script, label]).run(timeout: 120)
      let stdout = try output.text()
      report["\(label)Run"] = ["exitCode": output.exitCode, "stdout": stdout, "stderr": String(decoding: output.stderr, as: UTF8.self)]
      guard ["python:\(label)", "thread:ok", "child:ok", "native-files:ok"].allSatisfy(stdout.contains) else {
        throw ProbeError.failed("Python failed: \(stdout)")
      }
      let data = try Data(contentsOf: directory.appendingPathComponent("python-output.json"))
      let disk = try JSONSerialization.jsonObject(with: data) as? [String: String]
      let diagnostics = await client.diagnostics()
      guard disk?["label"] == label, disk?["input"] == input,
        disk?["thread"] == "ok", disk?["child"] == "ok",
        try Data(contentsOf: directory.appendingPathComponent("python-bytes.bin")) == Data([0, 128, 255, 10]),
        !FileManager.default.fileExists(atPath: directory.appendingPathComponent("blocked.txt").path),
        diagnostics.nativeOperations > before, !diagnostics.webViewAttached
      else { throw ProbeError.failed("Native file or invisible WebView verification failed") }
      report["\(label)NativeFile"] = disk
      progress("\(label) Python run passed: threads, child process, and native files")
    }
    report["diagnostics"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(await client.diagnostics()))
    try await sandbox.close()
    try await client.close()
    report["passed"] = true
  } catch {
    report["error"] = String(describing: error)
    try? await runtime?.close()
  }
  return report
}
private enum ProbeError: Error { case failed(String) }
