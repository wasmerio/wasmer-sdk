import Foundation
import Testing
@testable import WasmerWKSDK

struct NativeFileSystemTests {
  func request(_ fs: NativeFileSystem, _ method: String, _ args: [Any], mount: Int = 1) async throws -> [String: Any] {
    let data = try JSONSerialization.data(withJSONObject: ["mount": mount, "method": method, "args": args])
    let response = await fs.dispatch(data)
    return try #require(JSONSerialization.jsonObject(with: response) as? [String: Any])
  }

  @Test func nativeFilesAndConfinement() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let fs = try NativeFileSystem(directory: root)
    let opened = try await request(fs, "open", ["hello.bin", true, true, true, false, true, false])
    let id = try #require(opened["value"] as? Int)
    let bytes = [0, 128, 255, 10]
    let written = try await request(fs, "write", [id, 0, bytes])
    #expect(written["value"] as? Int == 4)
    let read = try await request(fs, "read", [id, 1, 3])
    #expect(read["value"] as? [Int] == [128, 255, 10])
    _ = try await request(fs, "flush", [id])
    #expect(try Data(contentsOf: root.appendingPathComponent("hello.bin")) == Data(bytes.map(UInt8.init)))
    _ = try await request(fs, "close", [id])
    _ = try await request(fs, "close", [id])
    let missing = try await request(fs, "stat", ["missing"])
    #expect((missing["error"] as? [String: String])?["code"] == "ENOENT")
    for path in ["../escape", "/etc/passwd", "sub/../../escape"] {
      let response = try await request(fs, "open", [path, false, true, true, false, false, false])
      #expect((response["error"] as? [String: String])?["code"] == "EACCES")
    }
    try FileManager.default.createSymbolicLink(atPath: root.appendingPathComponent("escape").path, withDestinationPath: root.deletingLastPathComponent().path)
    let escaped = try await request(fs, "open", ["escape/outside", false, true, true, false, false, false])
    #expect(escaped["error"] != nil)
    let readOnly = try await request(fs, "open", ["blocked", false, true, true, false, false, false], mount: 2)
    #expect((readOnly["error"] as? [String: String])?["code"] == "EACCES")
    await fs.shutdown()
    await fs.shutdown()
    let closed = try await request(fs, "stat", ["hello.bin"])
    #expect(closed["error"] != nil)
  }
}
