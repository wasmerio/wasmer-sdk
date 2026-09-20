import Foundation
import Testing
@testable import WasmerWKSDK

@MainActor
struct NativeFileSystemTests {
  func request(_ fs: NativeFileSystem, _ method: String, _ args: [Any], mount: Int = 1) async throws -> [String: Any] {
    do {
      let request = try NativeFileSystemRequest(["method": method, "args": args])
      return await fs.dispatch(request, readOnly: mount == 2).object
    } catch {
      return NativeFileSystemResponse.error(try #require(error as? NativeIOError)).object
    }
  }

  @Test func binaryTransfersPreserveBytesOffsetsAndLimits() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let fs = try NativeFileSystem(directory: root)
    let opened = try await request(fs, "open", ["binary", true, true, true, false, true, false])
    let id = try #require(opened["value"] as? Int)
    let bytes = Data((0..<65536).map { UInt8($0 % 256) })
    let written = try await request(fs, "writeBytes", [id, 3, bytes.base64EncodedString()])
    #expect(written["value"] as? Int == bytes.count)
    let read = try await request(fs, "readBytes", [id, 3, bytes.count])
    #expect(read["value"] as? String == bytes.base64EncodedString())
    #expect(try Data(contentsOf: root.appendingPathComponent("binary")) == Data([0, 0, 0]) + bytes)
    let eof = try await request(fs, "readBytes", [id, bytes.count + 3, 64])
    #expect(eof["value"] as? String == "")
    let empty = try await request(fs, "writeBytes", [id, 0, ""])
    #expect(empty["value"] as? Int == 0)
    for invalid in ["not base64!", (bytes + Data([1])).base64EncodedString()] {
      let response = try await request(fs, "writeBytes", [id, 0, invalid])
      #expect((response["error"] as? [String: String])?["code"] == "EINVAL")
    }
    let oversized = try await request(fs, "readBytes", [id, 0, 65537])
    #expect((oversized["error"] as? [String: String])?["code"] == "EINVAL")
    let denied = try await request(fs, "writeBytes", [id, 0, "AA=="], mount: 2)
    #expect((denied["error"] as? [String: String])?["code"] == "EACCES")
    await fs.shutdown()
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

  @Test func metadataAndMutationsKeepTheJavaScriptReplyFormat() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let fs = try NativeFileSystem(directory: root)
    let name = "café-\"file\".bin"
    let created = try await request(fs, "mkdir", ["sub"])
    #expect(created["value"] is NSNull)
    let opened = try await request(fs, "open", ["sub/" + name, true, true, true, true, false, false])
    let id = try #require(opened["value"] as? Int)
    // Sparse files verify that metadata keeps sizes above the 32-bit boundary.
    let length = Int64(1) << 32
    _ = try await request(fs, "setLen", [id, length])
    let stat = try await request(fs, "stat", ["sub/" + name])
    let metadata = try #require(stat["value"] as? [String: Any])
    #expect(metadata["kind"] as? String == "file")
    #expect(metadata["size"] as? Int64 == length)
    let listing = try await request(fs, "readDir", ["sub"])
    let entries = try #require(listing["value"] as? [[String: Any]])
    #expect(entries.count == 1)
    #expect(entries.first?["name"] as? String == name)
    #expect(entries.first?["size"] as? Int64 == length)
    let directory = try await request(fs, "stat", ["sub"])
    #expect((directory["value"] as? [String: Any])?["kind"] as? String == "directory")
    _ = try await request(fs, "setLen", [id, 0])
    _ = try await request(fs, "writeBytes", [id, 0, "YQ=="])
    let appended = try await request(fs, "open", ["sub/" + name, false, true, false, false, false, true])
    let appendID = try #require(appended["value"] as? Int)
    _ = try await request(fs, "write", [appendID, 1, [98]])
    let synced = try await request(fs, "sync", [])
    #expect(synced["value"] is NSNull)
    _ = try await request(fs, "rename", ["sub/" + name, "renamed"])
    #expect(try Data(contentsOf: root.appendingPathComponent("renamed")) == Data("ab".utf8))
    _ = try await request(fs, "close", [appendID])
    _ = try await request(fs, "close", [id])
    _ = try await request(fs, "remove", ["renamed"])
    _ = try await request(fs, "remove", ["sub"])
    let empty = try await request(fs, "readDir", ["."])
    #expect((empty["value"] as? [[String: Any]])?.isEmpty == true)
    await fs.shutdown()
  }

  @Test func malformedMessagesAndReadOnlyMountsStayRejected() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try Data("unchanged".utf8).write(to: root.appendingPathComponent("file"))
    let fs = try NativeFileSystem(directory: root)
    let opened = try await request(fs, "open", ["file", true, true, false, false, false, false])
    let id = try #require(opened["value"] as? Int)
    let writes: [(String, [Any])] = [
      ("write", [id, 0, [1]]), ("writeBytes", [id, 0, "AA=="]), ("setLen", [id, 0]),
      ("mkdir", ["dir"]), ("remove", ["file"]), ("rename", ["file", "renamed"]),
      ("open", ["file", false, true, false, false, true, false]),
    ]
    for (method, args) in writes {
      let response = try await request(fs, method, args, mount: 2)
      #expect((response["error"] as? [String: String])?["code"] == "EACCES")
    }
    let invalid: [(String, [Any])] = [
      ("readBytes", [id, -1, 1]), ("readBytes", [id, 0.5, 1]),
      ("readBytes", [id, Double.nan, 1]), ("readBytes", [id, Double.infinity, 1]),
      ("readBytes", [id, 9_007_199_254_740_992 as Int64, 1]),
      ("readBytes", [id, true, 1]), ("readBytes", [id, NSNull(), 1]),
      ("readBytes", []), ("open", ["file"]), ("stat", ["bad\0path"]),
      ("write", [id, 0, [-1]]), ("write", [id, 0, [256]]),
    ]
    for (method, args) in invalid {
      let response = try await request(fs, method, args)
      #expect((response["error"] as? [String: String])?["code"] == "EINVAL")
    }
    let unknown = try await request(fs, "unknown", [])
    #expect((unknown["error"] as? [String: String])?["code"] == "ENOTSUP")
    #expect(throws: NativeIOError.self) { try NativeFileSystemRequest(["args": []]) }
    #expect(try String(contentsOf: root.appendingPathComponent("file"), encoding: .utf8) == "unchanged")
    await fs.shutdown()
  }
}
