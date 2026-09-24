import Foundation
import Network
import Testing
@testable import WasmerWKSDK

private actor EchoStream {
  var chunks: [Data] = []
  var pending: CheckedContinuation<Data, Never>?
  var eof = false
  var closed = false

  func read() async -> Data {
    if !chunks.isEmpty { return chunks.removeFirst() }
    if eof { return Data() }
    return await withCheckedContinuation { pending = $0 }
  }
  func write(_ bytes: Data) {
    if let pending { self.pending = nil; pending.resume(returning: bytes) }
    else { chunks.append(bytes) }
  }
  func shutdown() { eof = true; pending?.resume(returning: Data()); pending = nil }
  func close() { closed = true; shutdown() }
  func stream() -> GuestTCPStream {
    GuestTCPStream(read: { await self.read() }, write: { await self.write($0) },
                   shutdownWrite: { await self.shutdown() }, close: { await self.close() })
  }
}

struct GuestTCPServerTests {
  @Test(.timeLimit(.minutes(1)))
  func forwardsBinaryBytesAndDrainsAfterClientHalfClose() async throws {
    let echo = EchoStream()
    let server = GuestTCPServer { await echo.stream() }
    let port = try await server.start()
    defer { server.stop() }
    let connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
    connection.start(queue: DispatchQueue(label: "test.tcp"))
    defer { connection.cancel() }
    let expected = Data((0..<131_073).map { UInt8($0 % 256) })
    try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
      connection.send(content: expected, contentContext: .finalMessage, isComplete: true,
                      completion: .contentProcessed { error in
        if let error { c.resume(throwing: error) } else { c.resume() }
      })
    }
    var received = Data()
    while received.count < expected.count {
      let chunk: Data = try await withCheckedThrowingContinuation { c in
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { data, _, _, error in
          if let error { c.resume(throwing: error) } else { c.resume(returning: data ?? Data()) }
        }
      }
      if chunk.isEmpty { break }
      received.append(chunk)
    }
    #expect(received == expected)
  }

  @Test(.timeLimit(.minutes(1)))
  func stoppingClosesGuestEvenWithPendingReads() async throws {
    let echo = EchoStream()
    let server = GuestTCPServer { await echo.stream() }
    let port = try await server.start()
    defer { server.stop() }
    let connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
    connection.start(queue: DispatchQueue(label: "test.tcp.stop"))
    defer { connection.cancel() }
    // Wait until the forwarding pump has issued a guest read.
    for _ in 0..<200 {
      if await echo.pending != nil { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(await echo.pending != nil)
    server.stop()
    for _ in 0..<200 {
      if await echo.closed { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(await echo.closed)
  }
}
