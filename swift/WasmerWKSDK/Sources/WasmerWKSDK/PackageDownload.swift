import CryptoKit
import Foundation
import Network

/// Streams decoded URLSession chunks with backpressure. The terminating HTTP
/// chunk is withheld until SHA-256 verification, so Fetch rejects incomplete or
/// corrupt packages before the SDK can parse or run them. Delegate state is
/// confined to URLSession's serial delegate queue.
final class PackageDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let connection: NWConnection
  private let expectedHash: String
  private let destination: URL
  private let temporary: URL
  private let completed: @Sendable () -> Void
  private let taskLock = NSLock()
  private var task: URLSessionDataTask?
  private var file: FileHandle?
  private var digest = SHA256()
  private var count = 0
  private var accepted = false
  private var failed = false

  init(session: URLSession, url: URL, hash: String, destination: URL,
       connection: NWConnection, completed: @escaping @Sendable () -> Void) {
    self.connection = connection
    expectedHash = hash
    self.destination = destination
    temporary = destination.deletingLastPathComponent().appendingPathComponent(".download-" + UUID().uuidString)
    self.completed = completed
    super.init()
    task = session.dataTask(with: URLRequest(url: url, timeoutInterval: 60))
    task?.delegate = self
  }

  func start() { taskLock.withLock { task }?.resume() }
  func cancel() { taskLock.withLock { task }?.cancel() }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                  didReceive response: URLResponse,
                  completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
      completionHandler(.cancel); return
    }
    // Cache failure is non-fatal: the download remains usable without storage.
    try? FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
    if FileManager.default.createFile(atPath: temporary.path, contents: nil) {
      file = try? FileHandle(forWritingTo: temporary)
    }
    let headers = [
      "HTTP/1.1 200 OK", "Content-Type: application/webc", "Transfer-Encoding: chunked",
      "Cross-Origin-Opener-Policy: same-origin", "Cross-Origin-Embedder-Policy: require-corp",
      "Cross-Origin-Resource-Policy: same-origin", "Cache-Control: no-store", "Connection: close", "", "",
    ].joined(separator: "\r\n")
    connection.send(content: Data(headers.utf8), completion: .contentProcessed { error in
      if error != nil { dataTask.cancel() }
    })
    accepted = true
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard accepted, !failed else { return }
    count += data.count
    guard count <= 128 * 1024 * 1024 else { failed = true; dataTask.cancel(); return }
    digest.update(data: data)
    do { try file?.write(contentsOf: data) }
    catch { try? file?.close(); file = nil; try? FileManager.default.removeItem(at: temporary) }
    var chunk = Data("\(String(data.count, radix: 16))\r\n".utf8)
    chunk.append(data)
    chunk.append(Data("\r\n".utf8))
    dataTask.suspend()
    connection.send(content: chunk, completion: .contentProcessed { error in
      if error != nil { dataTask.cancel() }
      dataTask.resume()
    })
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    taskLock.withLock { self.task = nil }
    let hash = digest.finalize().map { String(format: "%02x", $0) }.joined()
    let valid = accepted && !failed && error == nil && hash == expectedHash
    try? file?.close()
    if valid, file != nil {
      // Content-addressed destinations are immutable; another client may have
      // already published an equally valid copy.
      try? FileManager.default.moveItem(at: temporary, to: destination)
    }
    try? FileManager.default.removeItem(at: temporary)
    file = nil
    // A graceful EOF is tolerated by some HTTP clients even without the last
    // chunk. Reset the connection on failure so partial bytes cannot succeed.
    guard valid else { connection.forceCancel(); completed(); return }
    connection.send(content: Data("0\r\n\r\n".utf8), completion: .contentProcessed { [completed] _ in completed() })
  }
}
