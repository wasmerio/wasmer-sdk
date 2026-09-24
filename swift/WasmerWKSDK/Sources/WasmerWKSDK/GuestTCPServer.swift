import Foundation
import Network

struct GuestTCPStream: Sendable {
  let read: @Sendable () async throws -> Data
  let write: @Sendable (Data) async throws -> Void
  let shutdownWrite: @Sendable () async throws -> Void
  let close: @Sendable () async -> Void
}

/// Loopback-only forwarding, with one bounded read/write in flight per direction.
/// Mutable listener state is confined to queue.
final class GuestTCPServer: @unchecked Sendable {
  private let queue = DispatchQueue(label: "io.wasmer.webkit.tcp")
  private let connect: @Sendable () async throws -> GuestTCPStream
  private var listener: NWListener?
  private var connections: [UUID: NWConnection] = [:]
  private var tasks: [UUID: Task<Void, Never>] = [:]
  private var stopped = false
  private var startupCompleted = false

  init(connect: @escaping @Sendable () async throws -> GuestTCPStream) {
    self.connect = connect
  }

  func start() async throws -> UInt16 {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        guard self.listener == nil, !self.stopped else {
          continuation.resume(throwing: CancellationError()); return
        }
        do {
          let parameters = NWParameters.tcp
          parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
          let listener = try NWListener(using: parameters)
          self.listener = listener
          listener.stateUpdateHandler = { state in
            guard !self.startupCompleted else { return }
            switch state {
            case .ready:
              guard let port = listener.port else { return }
              self.startupCompleted = true
              continuation.resume(returning: port.rawValue)
            case .failed(let error):
              self.startupCompleted = true
              continuation.resume(throwing: error)
              self.stop()
            case .cancelled:
              self.startupCompleted = true
              continuation.resume(throwing: CancellationError())
            default: break
            }
          }
          listener.newConnectionHandler = { connection in
            guard !self.stopped, self.connections.count < 16 else { connection.cancel(); return }
            let id = UUID()
            self.connections[id] = connection
            connection.start(queue: self.queue)
            self.tasks[id] = Task {
              await self.forward(connection)
              self.queue.async {
                self.connections.removeValue(forKey: id)
                self.tasks.removeValue(forKey: id)
              }
            }
          }
          listener.start(queue: self.queue)
        } catch { continuation.resume(throwing: error) }
      }
    }
  }

  func stop() {
    queue.async {
      self.stopped = true
      self.listener?.cancel(); self.listener = nil
      for connection in self.connections.values { connection.cancel() }
      for task in self.tasks.values { task.cancel() }
      self.connections.removeAll(); self.tasks.removeAll()
    }
  }

  private func forward(_ connection: NWConnection) async {
    await withTaskCancellationHandler {
      do {
        let stream = try await connect()
        do {
          try Task.checkCancellation()
          try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
              do {
                while true {
                  let (data, eof) = try await Self.receive(connection)
                  if !data.isEmpty { try await stream.write(data) }
                  if eof { try await stream.shutdownWrite(); return }
                }
              } catch {
                connection.cancel(); await stream.close(); throw error
              }
            }
            group.addTask {
              do {
                while true {
                  let data = try await stream.read()
                  if data.isEmpty { connection.cancel(); return }
                  try await Self.send(connection, data)
                }
              } catch {
                connection.cancel(); await stream.close(); throw error
              }
            }
            try await group.waitForAll()
          }
        } catch { /* Closing either endpoint interrupts both pumps. */ }
        await stream.close()
      } catch { /* A refused guest connection closes the native connection. */ }
      connection.cancel()
    } onCancel: { connection.cancel() }
  }

  private static func receive(_ connection: NWConnection) async throws -> (Data, Bool) {
    try await withCheckedThrowingContinuation { continuation in
      connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, eof, error in
        if let error { continuation.resume(throwing: error) }
        else { continuation.resume(returning: (data ?? Data(), eof)) }
      }
    }
  }

  private static func send(_ connection: NWConnection, _ data: Data) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      connection.send(content: data, completion: .contentProcessed { error in
        if let error { continuation.resume(throwing: error) }
        else { continuation.resume() }
      })
    }
  }
}
