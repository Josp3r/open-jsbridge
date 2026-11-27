import CFNetwork
import Foundation
import zlib

enum UploadTransport {
    @MainActor
    static func send(_ request: UploadRequest, jpeg: Data, progress: NativeIOSHost.ProgressReporter,
                     authorize: @MainActor () throws -> Void = {}) async throws -> [String: Any] {
        let boundary = "ojsb-" + UUID().uuidString
        let body = try await multipart(request, jpeg: jpeg, boundary: boundary)
        let transfer = try HTTPTransfer(request, body: body, boundary: boundary, progress: progress)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                do {
                    try Task.checkCancellation()
                    try authorize()
                    transfer.start(continuation)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        } onCancel: {
            if Thread.isMainThread {
                transfer.finish(.failure(CancellationError()))
            } else {
                DispatchQueue.main.async { transfer.finish(.failure(CancellationError())) }
            }
        }
    }

    /// Body preparation runs off the main actor so a large JPEG does not delay lifecycle notifications.
    private static func multipart(_ request: UploadRequest, jpeg: Data, boundary: String) async throws -> Data {
        try Task.checkCancellation()
        var body = Data()
        body.reserveCapacity(jpeg.count + 1024)
        for (key, value) in request.formData.sorted(by: { $0.key < $1.key }) {
            body.append(contentsOf: "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(key)\"\r\n\r\n".utf8)
            body.append(contentsOf: value.utf8)
            body.append(contentsOf: "\r\n".utf8)
        }
        body.append(contentsOf: "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(request.fieldName)\"; filename=\"image.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".utf8)
        body.append(jpeg)
        body.append(contentsOf: "\r\n--\(boundary)--\r\n".utf8)
        return body
    }

    // CFHTTPStream handles HTTP framing and system TLS verification. A streamed request uses a single
    // non-rewindable body, with no URLSession automatic authentication retries or resumable-upload negotiation.
    private final class HTTPTransfer: NSObject, StreamDelegate {
        private static let invalidResponse = UploadFailure(-32603, "invalid_response")
        private static let networkFailure = UploadFailure(-32603, "network_failure")
        private let stream: InputStream
        private let url: URL
        private let total: Int64
        private let progress: NativeIOSHost.ProgressReporter
        private var timer: Timer?
        private var reported: Int64 = 0
        private var reporting: Task<Void, Never>?
        private var completion: CheckedContinuation<[String: Any], Error>?
        private var response: HTTPURLResponse?
        private var encodedBytes = 0
        private var plain = Data()
        private var inflater: ResponseInflater?

        init(_ request: UploadRequest, body: Data, boundary: String, progress: NativeIOSHost.ProgressReporter) throws {
            url = request.url
            total = Int64(body.count)
            self.progress = progress
            let createdMessage: Unmanaged<CFHTTPMessage>? = CFHTTPMessageCreateRequest(nil, "POST" as CFString,
                                                                                      request.url as CFURL, kCFHTTPVersion1_1)
            guard let message = createdMessage?.takeRetainedValue() else { throw Self.networkFailure }
            for (key, value) in request.headers {
                CFHTTPMessageSetHeaderFieldValue(message, key as CFString, value as CFString)
            }
            CFHTTPMessageSetHeaderFieldValue(message, "Content-Type" as CFString, "multipart/form-data; boundary=\(boundary)" as CFString)
            CFHTTPMessageSetHeaderFieldValue(message, "Content-Length" as CFString, String(total) as CFString)
            CFHTTPMessageSetHeaderFieldValue(message, "Accept-Encoding" as CFString, "gzip, deflate" as CFString)
            let createdStream: Unmanaged<CFReadStream>? = CFReadStreamCreateForStreamedHTTPRequest(nil, message, InputStream(data: body) as CFReadStream)
            guard let read = createdStream?.takeRetainedValue() else { throw Self.networkFailure }
            // Keep a private, single-use connection; CFHTTPStream has no cookie jar or credential store.
            CFReadStreamSetProperty(read, .init(rawValue: kCFStreamPropertyHTTPShouldAutoredirect), kCFBooleanFalse)
            CFReadStreamSetProperty(read, .init(rawValue: kCFStreamPropertyHTTPAttemptPersistentConnection), kCFBooleanFalse)
            stream = read as InputStream
        }

        func start(_ continuation: CheckedContinuation<[String: Any], Error>) {
            completion = continuation
            stream.delegate = self
            stream.schedule(in: .main, forMode: .common)
            let poll = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in self?.sampleProgress() }
            timer = poll
            RunLoop.main.add(poll, forMode: .common)
            stream.open()
        }

        func stream(_ aStream: Stream, handle eventCode: Stream.Event) {
            guard completion != nil else { return }
            do {
                switch eventCode {
                case .hasBytesAvailable:
                    let response = try readResponse()
                    var buffer = [UInt8](repeating: 0, count: 4096)
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    guard count >= 0 else { throw Self.networkFailure }
                    if count > 0 {
                        if encodedBytes == 0 {
                            switch response.value(forHTTPHeaderField: "Content-Encoding")?.trimmingCharacters(in: .whitespaces).lowercased() {
                            case nil, "", "identity": break
                            case "gzip", "x-gzip": inflater = try ResponseInflater(window: 31)
                            case "deflate": inflater = try ResponseInflater(window: 15)
                            default: throw Self.invalidResponse
                            }
                        }
                        encodedBytes += count
                        if let inflater {
                            try inflater.append(&buffer, count: count, to: &plain)
                        } else {
                            try Self.appendPlain(buffer.prefix(count), to: &plain)
                        }
                    }
                case .endEncountered:
                    let response = try readResponse()
                    if response.value(forHTTPHeaderField: "Transfer-Encoding") == nil,
                       let length = response.value(forHTTPHeaderField: "Content-Length").flatMap(Int.init),
                       length != encodedBytes {
                        throw Self.networkFailure
                    }
                    guard inflater?.complete != false, plain.isEmpty || Self.isPublicText(response),
                          let text = String(data: plain, encoding: .utf8) else { throw Self.invalidResponse }
                    sampleProgress()
                    finish(.success(["status": response.statusCode, "body": text]))
                case .errorOccurred: throw Self.networkFailure
                default: break
                }
            } catch {
                finish(.failure(error))
            }
        }

        private func readResponse() throws -> HTTPURLResponse {
            if let response { return response }
            guard let header = stream.property(forKey: .init(rawValue: kCFStreamPropertyHTTPResponseHeader as String)),
                  CFGetTypeID(header as CFTypeRef) == CFHTTPMessageGetTypeID() else { throw Self.networkFailure }
            let message = header as! CFHTTPMessage
            let status = CFHTTPMessageGetResponseStatusCode(message)
            guard (100...599).contains(status) else { throw Self.invalidResponse }
            guard !(300..<400).contains(status) else { throw UploadFailure(-32003, "redirect_denied") }
            let fields = CFHTTPMessageCopyAllHeaderFields(message)?.takeRetainedValue() as? [String: String]
            guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: fields)
            else { throw Self.invalidResponse }
            self.response = response
            return response
        }

        private static func isPublicText(_ response: HTTPURLResponse) -> Bool {
            guard let header = response.value(forHTTPHeaderField: "Content-Type"),
                  let first = header.split(separator: ";", maxSplits: 1).first else { return false }
            let type = first.trimmingCharacters(in: .whitespaces).lowercased()
            if let encoding = response.textEncodingName?.lowercased(),
               !["utf-8", "utf8", "us-ascii"].contains(encoding) { return false }
            return (type.hasPrefix("text/") && type.count > 5) || type == "application/json" ||
                (type.hasPrefix("application/") && type.hasSuffix("+json") && type.count > "application/+json".count)
        }

        private func sampleProgress() {
            guard completion != nil, reporting == nil,
                  let sent = (stream.property(forKey: .init(rawValue: kCFStreamPropertyHTTPRequestBytesWrittenCount as String)) as? NSNumber)?.int64Value,
                  sent > reported, sent <= total else { return }
            reported = sent
            reporting = Task { @MainActor in
                if !Task.isCancelled { _ = await progress.send(["sent": sent, "total": total]) }
                reporting = nil
            }
        }

        // Stream callbacks, timers and cancellation all run on the main run loop.
        func finish(_ result: Result<[String: Any], Error>) {
            guard let continuation = completion else { return }
            timer?.invalidate()
            timer = nil
            stream.delegate = nil
            stream.remove(from: .main, forMode: .common)
            stream.close()
            switch result {
            case .success where reporting != nil:
                let pending = reporting
                Task { @MainActor in
                    await pending?.value
                    guard completion != nil else { return }
                    completion = nil
                    continuation.resume(with: result)
                }
            default:
                completion = nil
                reporting?.cancel()
                continuation.resume(with: result)
            }
        }

        static func appendPlain(_ chunk: ArraySlice<UInt8>, to bytes: inout Data) throws {
            guard chunk.count <= 32 * 1024 - bytes.count else { throw UploadFailure(-32006, "response_too_large") }
            bytes.append(contentsOf: chunk)
        }
    }

    private final class ResponseInflater {
        let window: Int32
        var complete = false
        private var state = z_stream()

        init(window: Int32) throws {
            self.window = window
            guard inflateInit2_(&state, window, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK
            else { throw UploadFailure(-32603, "invalid_response") }
        }

        deinit { inflateEnd(&state) }

        func append(_ input: inout [UInt8], count: Int, to plain: inout Data) throws {
            try input.withUnsafeMutableBufferPointer { input in
                state.next_in = input.baseAddress
                state.avail_in = uInt(count)
                defer { state.next_in = nil; state.next_out = nil }
                var output = [UInt8](repeating: 0, count: 4096)
                repeat {
                    if complete {
                        guard window == 31, inflateReset2(&state, window) == Z_OK
                        else { throw UploadFailure(-32603, "invalid_response") }
                        complete = false
                    }
                    let status = output.withUnsafeMutableBufferPointer { buffer in
                        state.next_out = buffer.baseAddress
                        state.avail_out = uInt(buffer.count)
                        return inflate(&state, Z_NO_FLUSH)
                    }
                    let produced = output.count - Int(state.avail_out)
                    try HTTPTransfer.appendPlain(output.prefix(produced), to: &plain)
                    if status == Z_STREAM_END {
                        complete = true
                        if state.avail_in == 0 { break }
                    } else if status == Z_BUF_ERROR && state.avail_in == 0 {
                        break
                    } else if status != Z_OK {
                        throw UploadFailure(-32603, "invalid_response")
                    }
                } while state.avail_in > 0 || state.avail_out == 0
            }
        }
    }
}
