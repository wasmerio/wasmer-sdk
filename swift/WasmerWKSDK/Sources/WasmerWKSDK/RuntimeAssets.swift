import Foundation
import CryptoKit

/// Clients using the same cache share a runtime origin. Its port and WebKit
/// profile live in Application Support, so OPFS survives cache eviction and
/// app restarts. A busy saved port is an error, never a silently empty volume.
@MainActor
final class RuntimeAssets {
  private struct Profile: Codable { let identifier: UUID; let port: UInt16 }
  private struct Entry { let task: Task<RuntimeAssets, Error>; var references: Int }
  private static var entries: [String: Entry] = [:]
  private static var stopping: [String: Task<Void, Never>] = [:]
  let url: URL
  let identifier: UUID
  private let server: LoopbackServer
  private let key: String

  private init(server: LoopbackServer, url: URL, identifier: UUID, key: String) {
    self.server = server; self.url = url; self.identifier = identifier; self.key = key
  }
  static func acquire(directory: URL, cache: URL) async throws -> RuntimeAssets {
    // Home changes when iOS replaces an app container during an update.
    let home = NSHomeDirectory() + "/"
    let path = cache.standardizedFileURL.path
    let key = path.hasPrefix(home) ? "~/" + path.dropFirst(home.count) : path
    if let task = stopping[key] { await task.value }
    if var entry = entries[key] {
      entry.references += 1; entries[key] = entry
      do { return try await entry.task.value }
      catch { await release(key); throw error }
    }
    let task = Task { @MainActor in
      let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        .appendingPathComponent("WasmerSDK/WebStorage", isDirectory: true)
      try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
      let hash = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
      let file = support.appendingPathComponent(hash + ".json")
      let saved: Profile? = FileManager.default.fileExists(atPath: file.path) ?
        try JSONDecoder().decode(Profile.self, from: Data(contentsOf: file)) : nil
      let server = LoopbackServer(directory: directory, cacheDirectory: cache, port: saved?.port ?? 0)
      do {
        let url = try await server.start()
        let profile = Profile(identifier: saved?.identifier ?? UUID(), port: UInt16(url.port!))
        try JSONEncoder().encode(profile).write(to: file, options: .atomic)
        return RuntimeAssets(server: server, url: url, identifier: profile.identifier, key: key)
      } catch { await server.stopAndWait(); throw error }
    }
    entries[key] = Entry(task: task, references: 1)
    do { return try await task.value }
    catch { await release(key); throw error }
  }
  func release() async { await Self.release(key) }
  private static func release(_ key: String) async {
    guard var entry = entries[key] else { return }
    entry.references -= 1
    if entry.references > 0 { entries[key] = entry; return }
    entries.removeValue(forKey: key)
    let task = Task { @MainActor in
      if let assets = try? await entry.task.value { await assets.server.stopAndWait() }
    }
    stopping[key] = task
    await task.value
    stopping.removeValue(forKey: key)
  }
}
