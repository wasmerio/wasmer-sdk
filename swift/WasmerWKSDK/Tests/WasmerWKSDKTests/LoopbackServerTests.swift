import Foundation
import Testing
@testable import WasmerWKSDK

struct LoopbackServerTests {
  @Test func occupiedPersistentPortFailsInsteadOfChangingOrigin() async throws {
    let directory = FileManager.default.temporaryDirectory
    let first = LoopbackServer(directory: directory)
    let url = try await first.start()
    let second = LoopbackServer(directory: directory, port: UInt16(url.port!))
    await #expect(throws: (any Error).self) { try await second.start() }
    await second.stopAndWait()
    await first.stopAndWait()
  }
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
  @Test @MainActor func runtimeOriginSurvivesRestartAndIsShared() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try Data("storage".utf8).write(to: root.appendingPathComponent("index.html"))
    let first = try await RuntimeAssets.acquire(directory: root, cache: root)
    let second = try await RuntimeAssets.acquire(directory: root, cache: root)
    #expect(first.url == second.url)
    #expect(first.identifier == second.identifier)
    await first.release()
    let (data, _) = try await URLSession.shared.data(from: second.url)
    #expect(data == Data("storage".utf8))
    let port = second.url.port, profile = second.identifier
    await second.release()
    let restarted = try await RuntimeAssets.acquire(directory: root, cache: root)
    #expect(restarted.url.port == port)
    #expect(restarted.identifier == profile)
    await restarted.release()
  }
}
