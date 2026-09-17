import Foundation
import WasmerWKSDK

@MainActor
func runPrototypeProbe(progress: @escaping (String) -> Void) async -> [String: Any] {
  var report: [String: Any] = [
    "passed": false, "package": "python/python@3.13.20",
    "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
  ]
  var runtime: HeadlessWasmer?
  var events: [String] = []
  do {
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let directory = documents.appendingPathComponent("WasmerWKSDKProbe")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let script = try String(contentsOf: Bundle.main.resourceURL!.appendingPathComponent("python-smoke.py"), encoding: .utf8)
    let client = try HeadlessWasmer(directory: directory)
    runtime = client
    client.onProgress = { event in events.append(event); progress(event) }
    let capabilities = try await client.start()
    report["capabilities"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(capabilities))
    guard capabilities.pageIsolated, capabilities.workerIsolated,
      capabilities.sharedArrayBuffer, !capabilities.webViewAttached else {
      throw WebKitRuntimeError.failed("Missing isolation/shared memory, or WebView was attached")
    }
    guard capabilities.jspi else {
      throw WebKitRuntimeError.failed(capabilities.jspiError ?? "Python requires JSPI in the worker (iOS 27+)")
    }
    progress("JSPI suspend/resume verified in the hidden WebView worker")
    for (label, input) in [("first", "hello from native Swift\n"), ("second", "new native input after idle\n")] {
      for filename in ["python-output.json", "python-bytes.bin", "blocked.txt"] {
        let file = directory.appendingPathComponent(filename)
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
      }
      try Data(input.utf8).write(to: directory.appendingPathComponent("input.txt"))
      progress("\(label) Python run: waiting detached for 5 seconds")
      try await Task.sleep(for: .seconds(5))
      let before = await client.nativeOperationCount
      let output = try await client.runPython(script, arguments: [label])
      report["\(label)Run"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(output))
      guard output.exitCode == 0, output.reason == "exited",
        ["python:\(label)", "thread:ok", "child:ok", "native-files:ok"].allSatisfy(output.stdout.contains)
      else { throw WebKitRuntimeError.failed("Python failed: \(output.stderr)\n\(output.stdout)") }
      let data = try Data(contentsOf: directory.appendingPathComponent("python-output.json"))
      let disk = try JSONSerialization.jsonObject(with: data) as? [String: String]
      guard disk?["label"] == label, disk?["input"] == input,
        disk?["thread"] == "ok", disk?["child"] == "ok",
        try Data(contentsOf: directory.appendingPathComponent("python-bytes.bin")) == Data([0, 128, 255, 10]),
        !FileManager.default.fileExists(atPath: directory.appendingPathComponent("blocked.txt").path),
        await client.nativeOperationCount > before, !client.isWebViewAttached
      else { throw WebKitRuntimeError.failed("Native file or invisible WebView verification failed") }
      report["\(label)NativeFile"] = disk
      progress("\(label) Python run passed: threads, child process, and native files")
    }
    report["nativeOperations"] = await client.nativeOperationCount
    report["webViewAttachedAfterRuns"] = client.isWebViewAttached
    await client.close()
    report["passed"] = true
  } catch {
    report["error"] = String(describing: error)
    await runtime?.close()
  }
  report["events"] = events
  return report
}
