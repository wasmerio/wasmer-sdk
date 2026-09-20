import Foundation
import Testing
@testable import WasmerWKSDK

struct ClientOptionsTests {
  @Test func validatesGuestMemoryBeforeStartingWebKit() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    for limit: UInt64 in [0, 63 * 1024 * 1024, 513 * 1024 * 1024, 192 * 1024 * 1024 + 1] {
      #expect(throws: SdkError.self) {
        try WasmerCore(options: ClientOptions(cacheRoot: root.path, outputBytes: nil, guestMemoryLimitBytes: limit))
      }
    }
    _ = try WasmerCore(options: ClientOptions(cacheRoot: root.path, outputBytes: nil, guestMemoryLimitBytes: 512 * 1024 * 1024))
  }
}
