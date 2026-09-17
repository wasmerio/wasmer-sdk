import Foundation
import Network
import Testing
@testable import WasmerWebKit

private func rpc(_ network: NativeNetwork, _ session: String, _ method: String, _ args: [Any] = []) async throws -> [String: Any] {
  let data = try JSONSerialization.data(withJSONObject: ["session": session, "method": method, "args": args])
  return try #require(JSONSerialization.jsonObject(with: await network.dispatch(data)) as? [String: Any])
}

private final class EchoServer: @unchecked Sendable {
  private let queue = DispatchQueue(label: "network-test")
  private var listener: NWListener?
  private var connections: [NWConnection] = []
  private let expected: Int
  private let host: String
  init(expected: Int, host: String = "127.0.0.1") { self.expected = expected; self.host = host }
  func start() async throws -> UInt16 {
    try await withCheckedThrowingContinuation { continuation in queue.async {
      do {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(self.host), port: .any)
        let listener = try NWListener(using: parameters); self.listener = listener
        listener.stateUpdateHandler = { [weak listener] state in
          if case .ready = state, let port = listener?.port {
            listener?.stateUpdateHandler = nil; continuation.resume(returning: port.rawValue)
          } else if case .failed(let error) = state {
            listener?.stateUpdateHandler = nil; continuation.resume(throwing: error)
          }
        }
        listener.newConnectionHandler = { connection in
          self.connections.append(connection); connection.start(queue: self.queue)
          self.echo(connection, received: 0)
        }
        listener.start(queue: self.queue)
      } catch { continuation.resume(throwing: error) }
    } }
  }
  private func echo(_ connection: NWConnection, received: Int) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, done, error in
      guard let data, !data.isEmpty, error == nil else { return }
      let count = received + data.count
      connection.send(content: data, contentContext: count >= self.expected ? .finalMessage : .defaultMessage,
        isComplete: true, completion: .contentProcessed { _ in })
      if count < self.expected && !done { self.echo(connection, received: count) }
    }
  }
  func stop() { queue.async {
    self.listener?.cancel(); self.listener?.newConnectionHandler = nil; self.listener = nil
    for connection in self.connections { connection.cancel() }; self.connections.removeAll()
  } }
}

struct NativeNetworkTests {
  @Test func nativeIPv6TCP() async throws {
    let network = NativeNetwork(); let session = UUID().uuidString
    _ = try await rpc(network, session, "open")
    let server = EchoServer(expected: 1, host: "::1"); let port = try await server.start()
    defer { server.stop() }
    let descriptor = try #require(try await rpc(network, session, "connectTcp", ["0.0.0.0:0", "[::1]:\(port)"])["value"] as? [String: Any])
    let id = try #require(descriptor["id"] as? Int)
    #expect((descriptor["local"] as? String)?.hasPrefix("[::1]:") == true)
    #expect(try await rpc(network, session, "socketWrite", [id, "YQ=="])["value"] as? Int == 1)
    #expect(try await rpc(network, session, "socketRead", [id])["value"] as? String == "YQ==")
    #expect(try await rpc(network, session, "socketRead", [id])["value"] is NSNull)
    await network.shutdown()
    #expect(await network.statistics().openSockets == 0)
  }

  @Test func nativeDNSAndBinaryTCP() async throws {
    let network = NativeNetwork(); let session = UUID().uuidString
    _ = try await rpc(network, session, "open")
    let addresses = try #require(try await rpc(network, session, "resolve", ["localhost"])["value"] as? [String])
    #expect(addresses.contains("127.0.0.1") || addresses.contains("::1"))
    let binary = Data((0..<524_288).map { UInt8($0 % 256) })
    let server = EchoServer(expected: binary.count); let port = try await server.start()
    defer { server.stop() }
    let descriptor = try #require(try await rpc(network, session, "connectTcp", ["0.0.0.0:0", "127.0.0.1:\(port)"])["value"] as? [String: Any])
    let id = try #require(descriptor["id"] as? Int)
    #expect((descriptor["local"] as? String)?.hasPrefix("127.0.0.1:") == true)
    for method in ["socketSetNoDelay", "socketSetKeepAlive"] {
      #expect(try await rpc(network, session, method, [id, true])["value"] as? Bool == true)
    }
    var sent = 0
    while sent < binary.count {
      let chunk = binary.subdata(in: sent..<min(sent + 65536, binary.count))
      let count = try #require(try await rpc(network, session, "socketWrite", [id, chunk.base64EncodedString()])["value"] as? Int)
      #expect(count > 0); sent += count
    }
    var received = Data()
    while true {
      let result = try await rpc(network, session, "socketRead", [id])
      if result["value"] is NSNull { break }
      let bytes = try #require((result["value"] as? String).flatMap { Data(base64Encoded: $0) })
      received.append(bytes)
    }
    #expect(received == binary)
    _ = try await rpc(network, session, "socketClose", [id])
    let stats = await network.statistics()
    #expect(stats.bytesRead == binary.count && stats.bytesWritten == binary.count)
    #expect(stats.resolutions == 1 && stats.connections == 1 && stats.openSockets == 0)
    await network.shutdown()
  }

  @Test func failedConnectAndSessionCloseReleasePendingReads() async throws {
    let network = NativeNetwork(); let session = UUID().uuidString
    _ = try await rpc(network, session, "open")
    let denied = try await rpc(network, session, "connectTcp", ["0.0.0.0:0", "127.0.0.1:1"])
    #expect((denied["error"] as? [String: String])?["code"] == "ECONNREFUSED")
    #expect(await network.statistics().openSockets == 0)
    let server = EchoServer(expected: 1); let port = try await server.start()
    defer { server.stop() }
    let descriptor = try #require(try await rpc(network, session, "connectTcp", ["0.0.0.0:0", "127.0.0.1:\(port)"])["value"] as? [String: Any])
    let id = try #require(descriptor["id"] as? Int)
    let read = Task { try await rpc(network, session, "socketRead", [id])["error"] as? [String: String] }
    try await Task.sleep(for: .milliseconds(20))
    _ = try await rpc(network, session, "close")
    #expect(try await read.value?["code"] == "ECONNABORTED")
    #expect(await network.statistics().openSockets == 0)
    let newer = UUID().uuidString
    _ = try await rpc(network, newer, "open")
    #expect((try await rpc(network, session, "resolve", ["localhost"])["error"] as? [String: String])?["code"] == "ENOTCONN")
    #expect((try await rpc(network, newer, "resolve", ["bad\0host"])["error"] as? [String: String])?["code"] == "EINVAL")
    await network.shutdown()
  }
}
