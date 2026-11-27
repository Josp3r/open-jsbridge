import Foundation
import Network
import XCTest
@testable import NativeIOSHost

final class UploadTransportTests: XCTestCase {
    @MainActor
    private func send(_ request: UploadRequest, jpeg: Data, progress: NativeIOSHost.ProgressReporter) async throws -> [String: Any] {
        let transfer = Task { try await UploadTransport.send(request, jpeg: jpeg, progress: progress) }
        let deadline = Task {
            try await Task.sleep(nanoseconds: 5_000_000_000)
            transfer.cancel()
        }
        defer { deadline.cancel() }
        return try await transfer.value
    }

    @MainActor
    func testServerReceivesOneMultipartImageAndTextAndReportsItsEntireLength() async throws {
        var progress = [[String: Int64]]()
        let received = expectation(description: "one multipart POST")
        let jpeg = Data([0xff, 0xd8, 0x00, 0xff, 0xd9])
        let server = try UploadTestServer { headers, body in
            XCTAssertTrue(headers.hasPrefix("POST /avatar HTTP/1.1\r\n"))
            XCTAssertTrue(headers.lowercased().contains("authorization: bearer native-only\r\n"))
            XCTAssertFalse(headers.lowercased().contains("upload-draft-interop-version:"), "The server must not negotiate resumable uploads")
            XCTAssertFalse(headers.lowercased().contains("upload-complete:"))
            let boundary = try XCTUnwrap(headers.components(separatedBy: "boundary=").last?.components(separatedBy: "\r\n").first)
            var expected = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\n相片\r\n".utf8)
            expected.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"image.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".utf8))
            expected.append(jpeg)
            expected.append(Data("\r\n--\(boundary)--\r\n".utf8))
            XCTAssertEqual(body, expected)
            received.fulfill()
            return .reply(201, ["Content-Type": "application/json"], Data("{\"ok\":true}".utf8))
        }
        defer { server.stop() }
        let request = try await server.startRequest()
        let reporter = NativeIOSHost.ProgressReporter { chunk in
            if let sample = chunk as? [String: Int64] { progress.append(sample) }
            return true
        }
        let result = try await send(request, jpeg: jpeg, progress: reporter)
        XCTAssertEqual(result["status"] as? Int, 201)
        XCTAssertEqual(result["body"] as? String, "{\"ok\":true}")
        await fulfillment(of: [received], timeout: 2)
        XCTAssertFalse(progress.isEmpty)
        let sent = progress.compactMap { $0["sent"] }
        XCTAssertEqual(sent, sent.sorted())
        XCTAssertTrue(progress.allSatisfy { $0["total"] == Int64(server.bodySize) })
        XCTAssertEqual(sent.last, Int64(server.bodySize))
        XCTAssertEqual(server.requests, 1)
    }

    @MainActor
    func testResponseStatusTextAndEmptyBody() async throws {
        for (status, headers, bytes, expected) in [
            (413, ["Content-Type": "text/plain; charset=utf-8"], Data("照片过大".utf8), "照片过大"),
            (204, [:], Data(), ""),
            (401, ["WWW-Authenticate": "Basic realm=\"private\"", "Content-Type": "text/plain"], Data("denied".utf8), "denied")
        ] {
            let server = try UploadTestServer { _, _ in .reply(status, headers, bytes) }
            defer { server.stop() }
            let request = try await server.startRequest()
            let result = try await send(request, jpeg: Data([1]), progress: .init { _ in false })
            XCTAssertEqual(result["status"] as? Int, status)
            XCTAssertEqual(result["body"] as? String, expected)
            XCTAssertEqual(server.requests, 1)
        }
    }

    @MainActor
    func testRejectsRedirectMalformedResponseAndLostReplyWithoutReplaying() async throws {
        let compressed = Data(base64Encoded: "H4sIAAAAAAAC/+3BAQEAAACAkNvN7wgKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGi+2gVgAYAAAA==")!
        let cases: [(UploadTestServer.Response, Int, String?)] = [
            (.reply(307, ["Location": "/forbidden"], Data()), -32003, "redirect_denied"),
            (.reply(304, [:], Data()), -32003, "redirect_denied"),
            (.raw("HTTP/1.1 307 Temporary Redirect\r\nLocation: /denied\r\nContent-Length: 1000\r\n\r\nx", close: false),
             -32003, "redirect_denied"),
            (.raw("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 20\r\n\r\nshort", close: true),
             -32603, "network_failure"),
            (.reply(200, ["Content-Type": "text/plain", "Content-Encoding": "gzip"], compressed), -32006, nil),
            (.reply(200, ["Content-Type": "text/plain"], Data([0xff])), -32603, "invalid_response"),
            (.reply(200, ["Content-Type": "application/octet-stream"], Data([42])), -32603, "invalid_response"),
            (.disconnect, -32603, "network_failure")
        ]
        for (response, code, reason) in cases {
            let server = try UploadTestServer { _, _ in response }
            defer { server.stop() }
            let request = try await server.startRequest()
            do {
                _ = try await send(request, jpeg: Data([1]), progress: .init { _ in false })
                XCTFail("Unexpected successful transfer")
            } catch let error as UploadFailure {
                XCTAssertEqual(error.code, code)
                if let reason { XCTAssertEqual(error.reason, reason) }
            }
            XCTAssertEqual(server.requests, 1)
        }
    }

    @MainActor
    func testCompressionRequiresCompleteStreamsAndAcceptsExactly32KiBOfDecodedText() async throws {
        let full = Data(base64Encoded: "H4sIAAAAAAAC/+3BAQEAAACAkNvN7wgKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABjBGz66AIAAAA==")!
        let tail = Data(base64Encoded: "H4sIAAAAAAAC/6sEABUm2/sBAAAA")!
        let deflate = Data(base64Encoded: "eJx7OqHj2eapAA8BBCw=")!
        let valid: [(Data, String, String)] = [
            (full, "gzip", String(repeating: "x", count: 32_768)),
            (tail + tail, "gzip", "yy"),
            (deflate, "deflate", "合法")
        ]
        for (wire, encoding, expected) in valid {
            let server = try UploadTestServer { _, _ in .reply(200, ["Content-Type": "text/plain", "Content-Encoding": encoding], wire) }
            defer { server.stop() }
            let request = try await server.startRequest()
            let result = try await send(request, jpeg: Data([1]), progress: .init { _ in false })
            XCTAssertEqual(result["body"] as? String, expected)
        }
        for (wire, code) in [(Data(full.dropLast()), -32603), (full + tail, -32006), (tail + Data([42]), -32603)] {
            let server = try UploadTestServer { _, _ in .reply(200, ["Content-Type": "text/plain", "Content-Encoding": "gzip"], wire) }
            defer { server.stop() }
            let request = try await server.startRequest()
            do {
                _ = try await send(request, jpeg: Data([1]), progress: .init { _ in false })
                XCTFail("Unexpected complete response")
            } catch let error as UploadFailure {
                XCTAssertEqual(error.code, code)
            }
        }
    }

    @MainActor
    func testStalledRedirectDoesNotFollowLocationWhileWaitingForTheBody() async throws {
        let headersSent = expectation(description: "server sent redirect headers and holds the connection open")
        let server = try UploadTestServer { _, _ in
            .raw("HTTP/1.1 307 Temporary Redirect\r\nLocation: /denied\r\nContent-Length: 1000\r\n\r\n",
                 close: false, sent: { headersSent.fulfill() })
        }
        defer { server.stop() }
        let request = try await server.startRequest()
        let work = Task {
            try await UploadTransport.send(request, jpeg: Data([1]), progress: .init { _ in false })
        }
        await fulfillment(of: [headersSent], timeout: 3)
        // CFHTTPStream may expose the status only with the first body byte or EOF.
        work.cancel()
        do {
            _ = try await work.value
            XCTFail("Unexpected successful redirect")
        } catch let error as UploadFailure {
            XCTAssertEqual(error, UploadFailure(-32003, "redirect_denied"))
        } catch is CancellationError {}
        XCTAssertEqual(server.requests, 1)
    }

    @MainActor
    func testAuthorizationRecheckedBeforeConnectingAndCancellationInterruptsResponse() async throws {
        let arrived = expectation(description: "server received body")
        let server = try UploadTestServer { _, _ in arrived.fulfill(); return .hold }
        defer { server.stop() }
        let request = try await server.startRequest()
        do {
            _ = try await UploadTransport.send(request, jpeg: Data([1]), progress: .init { _ in false }) {
                throw UploadFailure(-32003, "expired_handle")
            }
            XCTFail("Expected the authorization check to stop the transfer")
        } catch let error as UploadFailure {
            XCTAssertEqual(error.code, -32003)
        }
        XCTAssertEqual(server.requests, 0)
        let work = Task {
            try await UploadTransport.send(request, jpeg: Data([1]), progress: .init { _ in false })
        }
        await fulfillment(of: [arrived], timeout: 4)
        work.cancel()
        do {
            _ = try await work.value
            XCTFail("Expected cancellation")
        } catch is CancellationError {
            XCTAssertEqual(server.requests, 1)
        }
    }
}

/// A loopback receiver exercises the native HTTP stream, decompression and redirect handling.
/// Production creates UploadRequest via the HTTPS endpoint policy; this fixture supplies only its own loopback URL.
private final class UploadTestServer {
    enum Response {
        case reply(Int, [String: String], Data), raw(String, close: Bool, sent: (() -> Void)? = nil), disconnect, hold
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "OpenJSBridge.upload-test-server")
    private let respond: (String, Data) throws -> Response
    private var connections = [NWConnection]()
    private var count = 0
    private var length = 0
    var requests: Int { queue.sync { count } }
    var bodySize: Int { queue.sync { length } }

    init(respond: @escaping (String, Data) throws -> Response) throws {
        self.respond = respond
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
    }

    func startRequest() async throws -> UploadRequest {
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            listener.stateUpdateHandler = { [self] state in
                switch state {
                case .ready:
                    listener.stateUpdateHandler = nil
                    continuation.resume(returning: listener.port!.rawValue)
                case .failed(let error):
                    listener.stateUpdateHandler = nil
                    continuation.resume(throwing: error)
                default: break
                }
            }
            listener.newConnectionHandler = { [self] connection in
                connections.append(connection)
                connection.start(queue: queue)
                read(connection, input: Data(), acknowledged: false)
            }
            listener.start(queue: queue)
        }
        return UploadRequest(id: "fixture", url: URL(string: "http://127.0.0.1:\(port)/avatar")!,
                             fieldName: "photo", formData: ["note": "相片"], headers: ["Authorization": "Bearer native-only"],
                             maxEdge: 2048, quality: 80)
    }

    func stop() {
        queue.sync {
            listener.newConnectionHandler = nil
            listener.cancel()
            connections.forEach { $0.cancel() }
            connections.removeAll()
        }
    }

    private func read(_ connection: NWConnection, input: Data, acknowledged: Bool) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 32_768) { [self] chunk, _, done, error in
            var input = input
            if let chunk { input.append(chunk) }
            guard let split = input.range(of: Data("\r\n\r\n".utf8)),
                  let headers = String(data: input[..<split.upperBound], encoding: .utf8) else {
                if !done && error == nil { read(connection, input: input, acknowledged: false) }
                return
            }
            if !acknowledged { count += 1 }
            if !acknowledged && headers.lowercased().contains("expect: 100-continue") {
                connection.send(content: Data("HTTP/1.1 100 Continue\r\n\r\n".utf8), completion: .idempotent)
            }
            let body = input.suffix(from: split.upperBound)
            guard let boundary = headers.components(separatedBy: "boundary=").dropFirst().first?.components(separatedBy: "\r\n").first,
                  body.range(of: Data("--\(boundary)--\r\n".utf8)) != nil else {
                if !done && error == nil { read(connection, input: input, acknowledged: true) }
                return
            }
            length = body.count
            do {
                switch try respond(headers, Data(body)) {
                case .disconnect: connection.cancel()
                case .hold: break
                case .raw(let wire, let close, let sent):
                    connection.send(content: Data(wire.utf8), completion: .contentProcessed { _ in
                        sent?()
                        if close { connection.cancel() }
                    })
                case .reply(let status, let fields, let bytes):
                    var header = "HTTP/1.1 \(status) Test\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n"
                    for (name, value) in fields { header += "\(name): \(value)\r\n" }
                    connection.send(content: Data((header + "\r\n").utf8) + bytes, completion: .contentProcessed { _ in
                        connection.cancel()
                    })
                }
            } catch {
                XCTFail("HTTP fixture failed: \(error)")
                connection.cancel()
            }
        }
    }
}
