import Darwin
import Foundation

public struct NativeNetworkStats: Sendable, Codable {
  public var resolutions = 0
  public var connections = 0
  public var bytesRead = 0
  public var bytesWritten = 0
  public var openSockets = 0
}

private struct NetworkFailure: Error {
  let code: String
  let message: String
  init(_ code: String, _ message: String) { self.code = code; self.message = message }
  init(_ number: Int32 = errno) {
    code = switch number {
    case ECONNREFUSED: "ECONNREFUSED"
    case ECONNRESET: "ECONNRESET"
    case ECONNABORTED: "ECONNABORTED"
    case ETIMEDOUT: "ETIMEDOUT"
    case EADDRINUSE: "EADDRINUSE"
    case EADDRNOTAVAIL: "EADDRNOTAVAIL"
    case EPIPE: "EPIPE"
    case ENOTCONN, EBADF: "ENOTCONN"
    case EACCES, EPERM: "EACCES"
    case EINVAL: "EINVAL"
    case EMFILE: "EMFILE"
    default: "EIO"
    }
    message = String(cString: strerror(number))
  }
}

/// Nonblocking native TCP descriptors, isolated on one dispatch queue. DNS runs
/// on a separate queue; neither a slow resolver nor a socket blocks the UI.
/// The bridge accepts messages only from the hidden runtime's current worker.
final class NativeNetwork: @unchecked Sendable {
  private typealias Reply = (Result<Any, NetworkFailure>) -> Void
  // All socket state, including cancellation handlers, stays on queue.
  private final class Socket: @unchecked Sendable {
    let fd: Int32
    let reader: DispatchSourceRead
    let writer: DispatchSourceWrite
    var reading = false
    var writing = false
    var closed = false
    var connect: Reply?
    var read: Reply?
    var write: Reply?
    var outbound = Data()
    var peer = ""
    init(fd: Int32, queue: DispatchQueue) {
      self.fd = fd
      reader = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
      writer = DispatchSource.makeWriteSource(fileDescriptor: fd, queue: queue)
      // The descriptor stays alive until both dispatch sources finish cancelling.
      var cancelled = 0
      let release = { cancelled += 1; if cancelled == 2 { Darwin.close(fd) } }
      reader.setCancelHandler(handler: release)
      writer.setCancelHandler(handler: release)
    }
    func wantsRead(_ value: Bool) {
      guard value != reading else { return }; reading = value
      if value { reader.resume() } else { reader.suspend() }
    }
    func wantsWrite(_ value: Bool) {
      guard value != writing else { return }; writing = value
      if value { writer.resume() } else { writer.suspend() }
    }
  }
  private let queue = DispatchQueue(label: "io.wasmer.webkit.network")
  private let dnsQueue = DispatchQueue(label: "io.wasmer.webkit.dns", attributes: .concurrent)
  private var session: String?
  private var sockets: [Int: Socket] = [:]
  private var lookups: [UUID: Reply] = [:]
  private var nextID = 0
  private var closed = false
  private var stats = NativeNetworkStats()
  static let chunkSize = 64 * 1024

  func statistics() async -> NativeNetworkStats {
    await withCheckedContinuation { reply in queue.async {
      var value = self.stats; value.openSockets = self.sockets.count
      reply.resume(returning: value)
    } }
  }

  func shutdown() async {
    await withCheckedContinuation { reply in queue.async {
      self.closed = true; self.reset(); reply.resume()
    } }
  }

  func dispatch(_ data: Data) async -> Data {
    await withCheckedContinuation { continuation in queue.async {
      let reply: Reply = { result in
        let body: [String: Any]
        switch result {
        case .success(let value): body = ["value": value]
        case .failure(let error): body = ["error": ["code": error.code, "message": error.message]]
        }
        continuation.resume(returning: try! JSONSerialization.data(withJSONObject: body))
      }
      do {
        guard !self.closed,
          let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let session = body["session"] as? String, UUID(uuidString: session) != nil,
          let method = body["method"] as? String,
          let args = body["args"] as? [Any] else { throw NetworkFailure(EINVAL) }
        if method == "open" {
          self.reset(); self.session = session; reply(.success(true)); return
        }
        guard self.session == session else { throw NetworkFailure(ENOTCONN) }
        if method == "close" { self.reset(); reply(.success(true)); return }
        try self.execute(method, args, reply)
      } catch { reply(.failure(error as? NetworkFailure ?? NetworkFailure(EINVAL))) }
    } }
  }

  private func reset() {
    session = nil
    for id in Array(sockets.keys) { closeSocket(id) }
    let pending = Array(lookups.values); lookups.removeAll()
    for reply in pending { reply(.failure(NetworkFailure(ECONNABORTED))) }
  }

  private func execute(_ method: String, _ args: [Any], _ reply: @escaping Reply) throws {
    if method == "resolve" {
      let host = try string(args, 0)
      guard !host.isEmpty, host.utf8.count <= 253, lookups.count < 16 else { throw NetworkFailure(EINVAL) }
      stats.resolutions += 1
      let id = UUID(); lookups[id] = reply
      dnsQueue.async {
        let result = Self.resolve(host)
        self.queue.async {
          guard let reply = self.lookups.removeValue(forKey: id) else { return }
          reply(result.map { $0 as Any })
        }
      }
      queue.asyncAfter(deadline: .now() + 30) {
        self.lookups.removeValue(forKey: id)?(.failure(NetworkFailure(ETIMEDOUT)))
      }
      return
    }
    if method == "connectTcp" {
      guard sockets.count < 64 else { throw NetworkFailure(EMFILE) }
      var local = try Self.address(string(args, 0))
      let peer = try Self.address(string(args, 1))
      if local.family != peer.family, ["0.0.0.0", "::"].contains(local.host) {
        local = try Self.address(peer.family == AF_INET6 ? "[::]:\(local.port)" : "0.0.0.0:\(local.port)")
      }
      guard peer.port > 0, local.family == peer.family else { throw NetworkFailure(EINVAL) }
      let fd = Darwin.socket(peer.family, SOCK_STREAM, IPPROTO_TCP)
      guard fd >= 0 else { throw NetworkFailure() }
      do {
        guard fcntl(fd, F_SETFL, O_NONBLOCK) == 0, fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 else { throw NetworkFailure() }
        var enabled: Int32 = 1
        guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size)) == 0 else { throw NetworkFailure() }
        if local.port != 0 || !["0.0.0.0", "::"].contains(local.host) {
          guard local.withAddress({ Darwin.bind(fd, $0, $1) }) == 0 else { throw NetworkFailure() }
        }
        let connected = peer.withAddress { Darwin.connect(fd, $0, $1) }
        guard connected == 0 || errno == EINPROGRESS else { throw NetworkFailure() }
        nextID += 1; let id = nextID
        let socket = Socket(fd: fd, queue: queue)
        socket.peer = peer.text; socket.connect = reply; sockets[id] = socket
        socket.reader.setEventHandler { [weak self, weak socket] in
          guard let self, let socket, !socket.closed else { return }; self.readReady(socket)
        }
        socket.writer.setEventHandler { [weak self, weak socket] in
          guard let self, let socket, !socket.closed else { return }
          if socket.connect != nil { self.connected(id, socket) } else { self.writeReady(socket) }
        }
        socket.wantsWrite(true)
        queue.asyncAfter(deadline: .now() + 30) { [weak socket] in
          guard let socket, socket.connect != nil else { return }
          self.closeSocket(id, failure: NetworkFailure(ETIMEDOUT))
        }
      } catch { Darwin.close(fd); throw error }
      return
    }
    let id = try integer(args, 0)
    if method == "socketClose" { closeSocket(id); reply(.success(true)); return }
    guard let socket = sockets[id], socket.connect == nil else { throw NetworkFailure(ENOTCONN) }
    switch method {
    case "socketRead":
      guard socket.read == nil else { throw NetworkFailure(EINVAL) }
      socket.read = reply; readReady(socket)
    case "socketWrite":
      guard socket.write == nil, let data = Data(base64Encoded: try string(args, 1)),
        !data.isEmpty, data.count <= Self.chunkSize else { throw NetworkFailure(EINVAL) }
      socket.outbound = data; socket.write = reply; writeReady(socket)
    case "socketSetNoDelay", "socketSetKeepAlive":
      guard args.count == 2, let enabled = args[1] as? Bool else { throw NetworkFailure(EINVAL) }
      var value: Int32 = enabled ? 1 : 0
      let tcp = method == "socketSetNoDelay"
      guard setsockopt(socket.fd, tcp ? IPPROTO_TCP : SOL_SOCKET, tcp ? TCP_NODELAY : SO_KEEPALIVE,
        &value, socklen_t(MemoryLayout<Int32>.size)) == 0 else { throw NetworkFailure() }
      reply(.success(true))
    default: throw NetworkFailure(EINVAL)
    }
  }

  private func connected(_ id: Int, _ socket: Socket) {
    var error: Int32 = 0; var size = socklen_t(MemoryLayout<Int32>.size)
    guard getsockopt(socket.fd, SOL_SOCKET, SO_ERROR, &error, &size) == 0 else {
      closeSocket(id, failure: NetworkFailure()); return
    }
    guard error == 0 else { closeSocket(id, failure: NetworkFailure(error)); return }
    socket.wantsWrite(false)
    stats.connections += 1
    let reply = socket.connect; socket.connect = nil
    reply?(.success(["id": id, "local": Self.localAddress(socket.fd), "peer": socket.peer]))
  }

  private func readReady(_ socket: Socket) {
    guard let reply = socket.read else { socket.wantsRead(false); return }
    var bytes = Data(count: Self.chunkSize)
    let count = bytes.withUnsafeMutableBytes { Darwin.recv(socket.fd, $0.baseAddress, $0.count, 0) }
    if count < 0, errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR {
      socket.wantsRead(true); return
    }
    socket.read = nil; socket.wantsRead(false)
    if count < 0 { reply(.failure(NetworkFailure())); return }
    stats.bytesRead += count
    reply(.success(count == 0 ? NSNull() : bytes.prefix(count).base64EncodedString()))
  }

  private func writeReady(_ socket: Socket) {
    guard let reply = socket.write else { socket.wantsWrite(false); return }
    let count = socket.outbound.withUnsafeBytes { Darwin.send(socket.fd, $0.baseAddress, $0.count, 0) }
    if count < 0, errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR {
      socket.wantsWrite(true); return
    }
    socket.write = nil; socket.outbound = Data(); socket.wantsWrite(false)
    if count < 0 { reply(.failure(NetworkFailure())); return }
    stats.bytesWritten += count
    reply(.success(count))
  }

  private func closeSocket(_ id: Int, failure: NetworkFailure = NetworkFailure(ECONNABORTED)) {
    guard let socket = sockets.removeValue(forKey: id) else { return }
    socket.closed = true
    let pending = [socket.connect, socket.read, socket.write]
    socket.connect = nil; socket.read = nil; socket.write = nil
    socket.wantsRead(true); socket.wantsWrite(true)
    socket.reader.cancel(); socket.writer.cancel()
    for reply in pending { reply?(.failure(failure)) }
  }

  private static func resolve(_ host: String) -> Result<[String], NetworkFailure> {
    var hints = addrinfo(); hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM
    var result: UnsafeMutablePointer<addrinfo>?
    let status = getaddrinfo(host, nil, &hints, &result)
    guard status == 0 else { return .failure(NetworkFailure("ENOTFOUND", String(cString: gai_strerror(status)))) }
    defer { if let result { freeaddrinfo(result) } }
    var values: [String] = []; var current = result
    while let item = current {
      var text = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      if getnameinfo(item.pointee.ai_addr, item.pointee.ai_addrlen, &text, socklen_t(text.count), nil, 0, NI_NUMERICHOST) == 0 {
        let address = Self.decode(text)
        if !values.contains(address) { values.append(address) }
      }
      current = item.pointee.ai_next
    }
    return values.isEmpty ? .failure(NetworkFailure("ENOTFOUND", "DNS returned no addresses")) : .success(values)
  }

  private struct Address {
    let host: String
    let port: UInt16
    let family: Int32
    let bytes: Data
    var text: String { family == AF_INET6 ? "[\(host)]:\(port)" : "\(host):\(port)" }
    func withAddress<T>(_ body: (UnsafePointer<sockaddr>, socklen_t) -> T) -> T {
      bytes.withUnsafeBytes { body($0.baseAddress!.assumingMemoryBound(to: sockaddr.self), socklen_t(bytes.count)) }
    }
  }
  private static func address(_ text: String) throws -> Address {
    guard let colon = text.lastIndex(of: ":"), let port = UInt16(text[text.index(after: colon)...]) else { throw NetworkFailure(EINVAL) }
    var host = String(text[..<colon])
    if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
    var hints = addrinfo(); hints.ai_flags = AI_NUMERICHOST | AI_NUMERICSERV
    hints.ai_socktype = SOCK_STREAM
    var result: UnsafeMutablePointer<addrinfo>?
    guard getaddrinfo(host, String(port), &hints, &result) == 0, let result else { throw NetworkFailure(EINVAL) }
    defer { freeaddrinfo(result) }
    return Address(host: host, port: port, family: result.pointee.ai_family,
      bytes: Data(bytes: result.pointee.ai_addr, count: Int(result.pointee.ai_addrlen)))
  }
  private static func localAddress(_ fd: Int32) -> String {
    var address = sockaddr_storage(); var length = socklen_t(MemoryLayout<sockaddr_storage>.size)
    return withUnsafeMutablePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { address in
        guard getsockname(fd, address, &length) == 0 else { return "0.0.0.0:0" }
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST)); var port = [CChar](repeating: 0, count: Int(NI_MAXSERV))
        guard getnameinfo(address, length, &host, socklen_t(host.count), &port, socklen_t(port.count), NI_NUMERICHOST | NI_NUMERICSERV) == 0 else { return "0.0.0.0:0" }
        let name = Self.decode(host)
        return address.pointee.sa_family == AF_INET6 ? "[\(name)]:\(Self.decode(port))" : "\(name):\(Self.decode(port))"
      }
    }
  }
  private static func decode(_ bytes: [CChar]) -> String {
    String(decoding: bytes.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
  }
  private func string(_ args: [Any], _ index: Int) throws -> String {
    guard args.indices.contains(index), let value = args[index] as? String, !value.utf8.contains(0) else { throw NetworkFailure(EINVAL) }
    return value
  }
  private func integer(_ args: [Any], _ index: Int) throws -> Int {
    guard args.indices.contains(index), let value = args[index] as? Int, value > 0 else { throw NetworkFailure(EINVAL) }
    return value
  }
}
