import Foundation
import Testing
@testable import WasmerWKSDK

private actor Requests {
  var values: [GuestHTTPRequest] = []
  func append(_ request: GuestHTTPRequest) { values.append(request) }
}

struct GuestHTTPServerTests {
  @Test func forwardsAuthenticatedBinaryRequestsAndPreservesHTTP() async throws {
    let requests = Requests()
    let server = GuestHTTPServer { request in
      await requests.append(request)
      return GuestHTTPResponse(status: 201, headers: [
        ["Content-Type", "application/octet-stream"], ["X-Guest", "yes"],
        ["Set-Cookie", "example=works; Path=/"], ["Content-Length", "42"],
      ], body: request.method == "HEAD" ? Data() : request.body)
    }
    let bootstrap = try await server.start()
    defer { server.stop() }
    let root = URL(string: "/", relativeTo: bootstrap)!.absoluteURL
    let session = URLSession(configuration: .ephemeral)
    let outsider = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel(); outsider.invalidateAndCancel() }

    let (_, denied) = try await outsider.data(from: root)
    #expect((denied as? HTTPURLResponse)?.statusCode == 403)
    let (_, welcome) = try await session.data(from: bootstrap)
    #expect((welcome as? HTTPURLResponse)?.statusCode == 201)

    let binary = Data((0..<16_384).map { UInt8($0 % 256) })
    var request = URLRequest(url: URL(string: "/echo?value=%F0%9F%90%AE", relativeTo: root)!)
    request.httpMethod = "POST"; request.httpBody = binary
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    let (bytes, response) = try await session.data(for: request)
    #expect(bytes == binary)
    #expect((response as? HTTPURLResponse)?.statusCode == 201)
    #expect((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "X-Guest") == "yes")
    let received = try #require(await requests.values.last)
    #expect(received.method == "POST")
    #expect(received.path == "/echo?value=%F0%9F%90%AE")
    #expect(received.body == binary)
    let cookies = received.headers.filter { $0[0] == "cookie" }.map { $0[1] }.joined()
    #expect(cookies.contains("example=works"))
    #expect(!cookies.contains("__wasmer_preview_"))

    request.httpMethod = "HEAD"; request.httpBody = nil
    let (headBody, headResponse) = try await session.data(for: request)
    #expect(headBody.isEmpty)
    #expect((headResponse as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Length") == "42")
    request.httpMethod = "GET"
    request.setValue("http://another-origin.invalid", forHTTPHeaderField: "Origin")
    let (_, crossOrigin) = try await session.data(for: request)
    #expect((crossOrigin as? HTTPURLResponse)?.statusCode == 403)
  }

  @Test func parsesFramingSeparatelyFromBinaryBody() throws {
    let headers = Data("POST /api?q=1 HTTP/1.1\r\nHost: localhost:8000\r\nContent-Length: 3\r\n\r\n".utf8)
    #expect(try GuestHTTPServer.parseHead(headers.prefix(12)) == nil)
    let request = try #require(try GuestHTTPServer.parseHead(headers + Data([255, 0, 128])))
    #expect(request.bodyOffset == headers.count)
    #expect(request.bodyLength == 3)
    #expect(request.path == "/api?q=1")
  }

  @Test func rejectsAmbiguousOrOversizedRequestFraming() {
    let cases: [(String, Int)] = [
      ("Content-Length: 1\r\nContent-Length: 2\r\n", 400),
      ("Content-Length: -1\r\n", 400),
      ("Content-Length: 1048577\r\n", 413),
      ("Transfer-Encoding: chunked\r\n", 501),
      ("Upgrade: websocket\r\n", 501),
      ("Host: duplicate\r\n", 400),
      ("Bad Header: value\r\n", 400),
    ]
    for (header, status) in cases {
      do {
        _ = try GuestHTTPServer.parseHead(Data("POST / HTTP/1.1\r\nHost: localhost\r\n\(header)\r\n".utf8))
        Issue.record("Accepted invalid framing: \(header)")
      } catch { #expect((error as? GuestHTTPServer.HTTPError)?.status == status) }
    }
    do {
      _ = try GuestHTTPServer.parseHead(Data(repeating: 65, count: 32 * 1024 + 1))
      Issue.record("Accepted oversized headers")
    } catch { #expect((error as? GuestHTTPServer.HTTPError)?.status == 431) }
  }
}
