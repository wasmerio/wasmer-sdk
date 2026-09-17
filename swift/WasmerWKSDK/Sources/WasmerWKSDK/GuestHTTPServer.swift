import Foundation
import Network

public struct GuestHTTPRequest: Sendable, Codable {
  public let method: String
  public let path: String
  public let headers: [[String]]
  public let body: Data

  public init(method: String, path: String, headers: [[String]] = [], body: Data = Data()) {
    self.method = method; self.path = path; self.headers = headers; self.body = body
  }
}

public struct GuestHTTPResponse: Sendable, Codable {
  public let status: Int
  public let headers: [[String]]
  public let body: Data

  public init(status: Int, headers: [[String]] = [], body: Data = Data()) {
    self.status = status; self.headers = headers; self.body = body
  }
}

/// An independent loopback origin for one guest HTTP listener. It serves no SDK
/// assets and has no native script bridge. Each request goes to the WASIX guest.
/// Mutable networking state is confined to queue.
public final class GuestHTTPServer: @unchecked Sendable {
  private let queue = DispatchQueue(label: "io.wasmer.webkit.preview")
  private let token = UUID().uuidString
  private let cookieName = "__wasmer_preview_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
  private let handler: @Sendable (GuestHTTPRequest) async throws -> GuestHTTPResponse
  private var listener: NWListener?
  private var connections: [UUID: NWConnection] = [:]
  private var requests: [UUID: Task<Void, Never>] = [:]
  private var authority = ""
  private var stopped = false
  private var startupCompleted = false
  static let maximumBody = 1024 * 1024
  static let maximumHeaders = 32 * 1024

  public init(handler: @escaping @Sendable (GuestHTTPRequest) async throws -> GuestHTTPResponse) {
    self.handler = handler
  }

  /// The returned URL installs a private HttpOnly capability cookie, then
  /// redirects to /. Absolute routes and fetch('/api') retain their semantics.
  public func start() async throws -> URL {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        guard self.listener == nil, !self.stopped else {
          continuation.resume(throwing: WebKitRuntimeError.failed("Preview already started or closed")); return
        }
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
              self.authority = "127.0.0.1:\(port.rawValue)"
              continuation.resume(returning: URL(string: "http://\(self.authority)/.wasmer-preview/\(self.token)")!)
            case .failed(let error):
              if !self.startupCompleted { self.startupCompleted = true; continuation.resume(throwing: error) }
              listener.cancel()
            case .cancelled:
              if !self.startupCompleted { self.startupCompleted = true; continuation.resume(throwing: CancellationError()) }
            default: break
            }
          }
          listener.newConnectionHandler = { connection in
            guard !self.stopped, self.connections.count < 16 else { connection.cancel(); return }
            let id = UUID()
            self.connections[id] = connection
            connection.start(queue: self.queue)
            self.queue.asyncAfter(deadline: .now() + 35) {
              if self.connections[id] != nil { self.send(id, response: .init(status: 504)) }
            }
            self.receive(id, buffer: Data())
          }
          listener.start(queue: self.queue)
        } catch { continuation.resume(throwing: error) }
      }
    }
  }

  public func stop() {
    queue.async {
      self.stopped = true
      self.listener?.cancel(); self.listener = nil
      for connection in self.connections.values { connection.cancel() }
      self.connections.removeAll()
      for request in self.requests.values { request.cancel() }
      self.requests.removeAll()
    }
  }

  struct RequestHead {
    let method: String
    let path: String
    let headers: [[String]]
    let bodyOffset: Int
    let bodyLength: Int
    func header(_ name: String) -> String? { headers.first { $0[0] == name }?[1] }
  }
  struct HTTPError: Error { let status: Int }

  /// Parse framing without decoding a binary request body as text.
  static func parseHead(_ bytes: Data) throws -> RequestHead? {
    guard let end = bytes.range(of: Data("\r\n\r\n".utf8)) else {
      if bytes.count > maximumHeaders { throw HTTPError(status: 431) }
      return nil
    }
    guard end.upperBound <= maximumHeaders,
      let text = String(data: bytes[..<end.lowerBound], encoding: .utf8) else { throw HTTPError(status: 400) }
    let lines = text.components(separatedBy: "\r\n")
    let parts = lines[0].split(separator: " ", omittingEmptySubsequences: false)
    guard parts.count == 3, ["HTTP/1.1", "HTTP/1.0"].contains(parts[2]),
      validHeaderName(String(parts[0])), parts[1].hasPrefix("/"), !parts[1].hasPrefix("//"),
      parts[1].utf8.allSatisfy({ $0 > 32 && $0 < 127 }) else { throw HTTPError(status: 400) }
    var headers: [[String]] = []
    for line in lines.dropFirst() {
      guard let colon = line.firstIndex(of: ":") else { throw HTTPError(status: 400) }
      let name = String(line[..<colon]).lowercased()
      let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
      guard validHeaderName(name), validHeaderValue(value) else { throw HTTPError(status: 400) }
      headers.append([name, value])
    }
    guard headers.filter({ $0[0] == "host" }).count == 1,
      headers.filter({ $0[0] == "content-length" }).count <= 1 else { throw HTTPError(status: 400) }
    // URLSession and WKWebView send fixed-size bodies for the demo. Streaming
    // uploads and protocol upgrades need a different transport.
    guard !headers.contains(where: { ["transfer-encoding", "upgrade", "expect"].contains($0[0]) }) else {
      throw HTTPError(status: 501)
    }
    let lengthText = headers.first { $0[0] == "content-length" }?[1] ?? "0"
    guard !lengthText.isEmpty, lengthText.utf8.allSatisfy({ (48...57).contains($0) }), let length = Int(lengthText) else {
      throw HTTPError(status: 400)
    }
    guard length <= maximumBody else { throw HTTPError(status: 413) }
    return RequestHead(method: String(parts[0]), path: String(parts[1]), headers: headers,
      bodyOffset: end.upperBound, bodyLength: length)
  }

  private static func validHeaderName(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.allSatisfy {
      (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || "!#$%&'*+-.^_`|~".utf8.contains($0)
    }
  }
  private static func validHeaderValue(_ value: String) -> Bool {
    value.utf8.allSatisfy { $0 == 9 || ($0 >= 32 && $0 != 127) }
  }

  private func receive(_ id: UUID, buffer: Data) {
    guard let connection = connections[id] else { return }
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { bytes, _, done, error in
      var buffer = buffer; buffer.append(bytes ?? Data())
      do {
        if let head = try Self.parseHead(buffer), buffer.count >= head.bodyOffset + head.bodyLength {
          self.forward(id, head: head, body: buffer.subdata(in: head.bodyOffset..<(head.bodyOffset + head.bodyLength)))
        } else if done || error != nil { self.finish(id) }
        else { self.receive(id, buffer: buffer) }
      } catch { self.send(id, response: .init(status: (error as? HTTPError)?.status ?? 400)) }
    }
  }

  private func forward(_ id: UUID, head: RequestHead, body: Data) {
    guard head.header("host") == authority else { send(id, response: .init(status: 403)); return }
    if let site = head.header("sec-fetch-site"), !["same-origin", "none"].contains(site) {
      send(id, response: .init(status: 403)); return
    }
    if let origin = head.header("origin"), origin != "http://" + authority {
      send(id, response: .init(status: 403)); return
    }
    if head.method == "GET", head.path == "/.wasmer-preview/" + token {
      send(id, response: .init(status: 302, headers: [
        ["Location", "/"], ["Set-Cookie", "\(cookieName)=\(token); Path=/; HttpOnly; SameSite=Strict"],
      ]), bootstrap: true)
      return
    }
    let cookies = head.headers.filter { $0[0] == "cookie" }.flatMap { $0[1].components(separatedBy: ";") }
      .map { $0.trimmingCharacters(in: .whitespaces) }
    guard cookies.contains(cookieName + "=" + token) else { send(id, response: .init(status: 403)); return }
    var headers = head.headers.filter { !["cookie", "connection", "content-length", "accept-encoding"].contains($0[0]) }
    let guestCookies = cookies.filter { !$0.hasPrefix("__wasmer_preview_") }
    if !guestCookies.isEmpty { headers.append(["cookie", guestCookies.joined(separator: "; ")]) }
    headers.append(["accept-encoding", "identity"])
    let request = GuestHTTPRequest(method: head.method, path: head.path, headers: headers, body: body)
    requests[id] = Task { [handler] in
      let response: GuestHTTPResponse
      do { response = try await handler(request) }
      catch { response = .init(status: 502, headers: [["Content-Type", "text/plain; charset=utf-8"]],
        body: Data("The guest server is unavailable. Return to the terminal to start it again.".utf8)) }
      self.queue.async { self.send(id, response: response, headOnly: head.method == "HEAD") }
    }
  }

  private func send(_ id: UUID, response: GuestHTTPResponse, headOnly: Bool = false, bootstrap: Bool = false) {
    guard let connection = connections[id] else { return }
    guard response.body.count <= 4 * 1024 * 1024, (200...599).contains(response.status) else {
      send(id, response: .init(status: 502)); return
    }
    let omitted = ["connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "trailer", "cache-control"]
    let headers = response.headers.filter {
      $0.count == 2 && Self.validHeaderName($0[0]) && Self.validHeaderValue($0[1]) && !omitted.contains($0[0].lowercased()) &&
      (bootstrap || $0[0].lowercased() != "set-cookie" || !$0[1].hasPrefix("__wasmer_preview_"))
    }
    // HEAD retains the guest's representation length while transmitting no body.
    let length = headOnly ? response.headers.first { $0.count == 2 && $0[0].lowercased() == "content-length" }.flatMap { Int($0[1]) } ?? 0 : response.body.count
    var lines = ["HTTP/1.1 \(response.status) Response"] + headers.map { "\($0[0]): \($0[1])" }
    lines += ["Content-Length: \(max(0, length))", "Connection: close", "Cache-Control: no-store",
      "Referrer-Policy: no-referrer", "Cross-Origin-Resource-Policy: same-origin", "X-Content-Type-Options: nosniff", "", ""]
    var bytes = Data(lines.joined(separator: "\r\n").utf8)
    if !headOnly { bytes.append(response.body) }
    connection.send(content: bytes, completion: .contentProcessed { _ in self.finish(id) })
  }

  private func finish(_ id: UUID) {
    connections.removeValue(forKey: id)?.cancel()
    requests.removeValue(forKey: id)?.cancel()
  }
}
