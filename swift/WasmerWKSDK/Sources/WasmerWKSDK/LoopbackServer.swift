import Foundation
import Network
import CryptoKit

/// Serves bundled assets only on IPv4 loopback, beneath an unguessable URL.
/// All mutable connection state is confined to `queue`.
final class LoopbackServer: @unchecked Sendable {
  private let directory: URL
  private let cacheDirectory: URL
  private let token = UUID().uuidString
  private let queue = DispatchQueue(label: "io.wasmer.webkit.assets")
  private var listener: NWListener?
  private var connections: [UUID: NWConnection] = [:]
  private var startupCompleted = false
  private let downloads = URLSession(configuration: .ephemeral)

  init(directory: URL, cacheDirectory: URL? = nil) {
    self.directory = directory.standardizedFileURL
    self.cacheDirectory = cacheDirectory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("WasmerWKSDKPackages")
  }

  func start() async throws -> URL {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        do {
          let parameters = NWParameters.tcp
          parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
          let listener = try NWListener(using: parameters)
          self.listener = listener
          listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
              guard !self.startupCompleted, let port = listener.port else { return }
              self.startupCompleted = true
              continuation.resume(returning: URL(string: "http://127.0.0.1:\(port.rawValue)/\(self.token)/index.html")!)
            case .failed(let error):
              if !self.startupCompleted { self.startupCompleted = true; continuation.resume(throwing: error) }
              listener.cancel()
            default: break
            }
          }
          listener.newConnectionHandler = { connection in
            let id = UUID()
            self.connections[id] = connection
            connection.start(queue: self.queue)
            self.receive(connection, id: id, buffer: Data())
          }
          listener.start(queue: self.queue)
        } catch { continuation.resume(throwing: error) }
      }
    }
  }

  func stop() {
    queue.async {
      self.listener?.cancel()
      self.listener = nil
      self.downloads.invalidateAndCancel()
      for connection in self.connections.values { connection.cancel() }
      self.connections.removeAll()
    }
  }

  private func receive(_ connection: NWConnection, id: UUID, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, done, error in
      var buffer = buffer
      buffer.append(data ?? Data())
      if buffer.count > 8192 {
        self.send(connection, id: id, status: 413, contentType: "text/plain", body: Data())
      } else if buffer.range(of: Data("\r\n\r\n".utf8)) != nil {
        self.respond(connection, id: id, request: buffer)
      } else if done || error != nil {
        connection.cancel()
        self.connections.removeValue(forKey: id)
      } else {
        self.receive(connection, id: id, buffer: buffer)
      }
    }
  }

  private func respond(_ connection: NWConnection, id: UUID, request: Data) {
    guard let text = String(data: request, encoding: .utf8),
      let line = text.components(separatedBy: "\r\n").first else { return }
    let parts = line.split(separator: " ")
    guard parts.count == 3, parts[0] == "GET",
      let path = String(parts[1]).components(separatedBy: "?")[0].removingPercentEncoding,
      path.hasPrefix("/\(token)/") else {
      send(connection, id: id, status: 404, contentType: "text/plain", body: Data()); return
    }
    let relative = String(path.dropFirst(token.count + 2))
    if relative.hasPrefix("__packages/") {
      downloadPackage(String(relative.dropFirst("__packages/".count)), connection: connection, id: id)
      return
    }
    let file = directory.appendingPathComponent(relative).standardizedFileURL.resolvingSymlinksInPath()
    let root = directory.resolvingSymlinksInPath().path + "/"
    guard !relative.utf8.contains(0), file.path.hasPrefix(root),
      let bytes = try? Data(contentsOf: file) else {
      send(connection, id: id, status: 404, contentType: "text/plain", body: Data()); return
    }
    let types = ["html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "wasm": "application/wasm", "json": "application/json"]
    send(connection, id: id, status: 200, contentType: types[file.pathExtension] ?? "application/octet-stream", body: bytes)
  }

  /// Only content-addressed public Wasmer packages are downloadable. Verify
  /// SHA-256 before caching or exposing any bytes to the WebView.
  private func downloadPackage(_ filename: String, connection: NWConnection, id: UUID) {
    let hash = String(filename.prefix(64))
    guard filename == hash + ".webc", hash.count == 64,
      hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
      send(connection, id: id, status: 404, contentType: "text/plain", body: Data()); return
    }
    let cache = cacheDirectory
    let destination = cache.appendingPathComponent(filename)
    let valid: @Sendable (Data) -> Bool = { bytes in
      SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() == hash
    }
    if let bytes = try? Data(contentsOf: destination), valid(bytes) {
      send(connection, id: id, status: 200, contentType: "application/webc", body: bytes)
      return
    }
    let url = URL(string: "https://cdn.wasmer.io/webcimages/\(filename)")!
    downloads.downloadTask(with: URLRequest(url: url, timeoutInterval: 60)) { temporary, response, error in
      var bytes: Data?
      if error == nil, (response as? HTTPURLResponse)?.statusCode == 200, let temporary,
        let size = try? temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize,
        // Edge.js 0.2.0 is approximately 74 MiB, including its Node libraries.
        size <= 128 * 1024 * 1024,
        let downloaded = try? Data(contentsOf: temporary), valid(downloaded) {
        bytes = downloaded
        try? FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
        try? downloaded.write(to: destination, options: .atomic)
      }
      let result = bytes
      self.queue.async {
        self.send(connection, id: id, status: result == nil ? 502 : 200,
          contentType: "application/webc", body: result ?? Data("Package download or hash verification failed".utf8))
      }
    }.resume()
  }

  private func send(_ connection: NWConnection, id: UUID, status: Int, contentType: String, body: Data) {
    let headers = [
      "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")",
      "Content-Type: \(contentType)", "Content-Length: \(body.count)",
      "Cross-Origin-Opener-Policy: same-origin",
      "Cross-Origin-Embedder-Policy: require-corp",
      "Cross-Origin-Resource-Policy: same-origin",
      "Cache-Control: no-store", "Connection: close", "", "",
    ].joined(separator: "\r\n")
    var response = Data(headers.utf8)
    response.append(body)
    connection.send(content: response, completion: .contentProcessed { _ in
      connection.cancel()
      self.connections.removeValue(forKey: id)
    })
  }
}
