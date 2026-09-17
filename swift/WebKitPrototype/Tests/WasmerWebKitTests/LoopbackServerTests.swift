import Foundation
import Testing
@testable import WasmerWebKit

struct LoopbackServerTests {
  @Test func servesIsolatedAssetsOnlyBelowToken() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    try Data("hello".utf8).write(to: directory.appendingPathComponent("index.html"))
    let server = LoopbackServer(directory: directory)
    let url = try await server.start()
    defer { server.stop() }
    let (bytes, response) = try await URLSession.shared.data(from: url)
    let http = try #require(response as? HTTPURLResponse)
    #expect(String(decoding: bytes, as: UTF8.self) == "hello")
    #expect(http.value(forHTTPHeaderField: "Cross-Origin-Opener-Policy") == "same-origin")
    #expect(http.value(forHTTPHeaderField: "Cross-Origin-Embedder-Policy") == "require-corp")
    let invalid = url.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("index.html")
    let (_, denied) = try await URLSession.shared.data(from: invalid)
    #expect((denied as? HTTPURLResponse)?.statusCode == 404)
  }
}
