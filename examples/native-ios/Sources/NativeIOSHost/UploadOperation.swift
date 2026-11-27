import Foundation

/// Lifetime of one foreground upload, owned by its verified document on the main thread.
final class UploadOperation {
    typealias Send = @MainActor (UploadRequest, Data, NativeIOSHost.ProgressReporter,
                                 @MainActor () throws -> Void) async throws -> [String: Any]

    private let request: UploadRequest
    private let media: MediaStore
    private let deadline: DispatchTime
    private let isForeground: () -> Bool
    private let send: Send
    private var cancelTimeout: (() -> Void)?
    private var lease: MediaStore.UploadLease?
    private var work: Task<Void, Never>?
    private var waiting: CheckedContinuation<Any, Error>?
    private(set) var outcome: Result<Any, Error>?

    init(request: UploadRequest, media: MediaStore, timeout: Int64, isForeground: @escaping () -> Bool,
         schedule: @escaping ScheduleDeadline = scheduleDeadline,
         send: @escaping Send = UploadTransport.send) throws {
        guard timeout > 0 else { throw UploadFailure(-32001, "timeout") }
        guard isForeground() else { throw UploadFailure(-32003, "not_foreground") }
        self.request = request
        self.media = media
        self.isForeground = isForeground
        self.send = send
        // A safe JSON integer in milliseconds can exceed Dispatch's nanosecond range.
        deadline = DispatchTime.now() + .milliseconds(Int(min(timeout, Int64(Int.max / 1_000_000))))
        lease = try media.lease(request.id) { [weak self] in self?.cancel(UploadFailure(-32003, "invalid_handle")) }
        cancelTimeout = schedule(deadline) { [weak self] in self?.cancel(UploadFailure(-32001, "timeout")) }
    }

    @MainActor
    func run(progress: NativeIOSHost.ProgressReporter) async throws -> Any {
        if let outcome { return try outcome.get() }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { completion in
                waiting = completion
                if Task.isCancelled {
                    cancel(UploadFailure(-32002, "cancelled"))
                    return
                }
                work = Task { @MainActor in
                    do {
                        if let confirm = request.confirm {
                            _ = try authorizedBytes()
                            let allowed = await confirm(request.id)
                            _ = try authorizedBytes()
                            guard allowed else { throw UploadFailure(-32007, "user_denied") }
                        }
                        let jpeg = try await Self.prepare(authorizedBytes(), maxEdge: request.maxEdge, quality: request.quality)
                        _ = try authorizedBytes()
                        let response = try await send(request, jpeg, progress) { _ = try self.authorizedBytes() }
                        _ = try authorizedBytes()
                        finish(.success(response))
                    } catch {
                        finish(.failure(Self.failure(for: error)))
                    }
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancel(UploadFailure(-32002, "cancelled")) }
        }
    }

    func cancel(_ failure: UploadFailure) {
        guard outcome == nil else { return }
        work?.cancel()
        finish(.failure(failure))
    }

    private func finish(_ result: Result<Any, Error>) {
        guard outcome == nil else { return }
        outcome = result
        lease = nil
        cancelTimeout?()
        cancelTimeout = nil
        work = nil
        waiting?.resume(with: result)
        waiting = nil
    }

    private func authorizedBytes() throws -> Data {
        if let outcome {
            if case .failure(let error) = outcome { throw error }
            throw UploadFailure(-32002, "cancelled")
        }
        let failure: UploadFailure
        if DispatchTime.now() >= deadline {
            failure = UploadFailure(-32001, "timeout")
        } else if !isForeground() {
            failure = UploadFailure(-32002, "backgrounded")
        } else if let source = media.bytes(for: request.id) {
            return source
        } else {
            failure = UploadFailure(-32003, "invalid_handle")
        }
        cancel(failure)
        throw failure
    }

    private static func prepare(_ source: Data, maxEdge: Int, quality: Int) async throws -> Data {
        let encoder = Task.detached(priority: .utility) {
            try UploadImage.prepare(data: source, maxEdge: maxEdge, quality: quality, isCancelled: { Task.isCancelled })
        }
        return try await withTaskCancellationHandler {
            try await encoder.value
        } onCancel: {
            encoder.cancel()
        }
    }

    private static func failure(for error: Error) -> UploadFailure {
        if let failure = error as? UploadFailure { return failure }
        if error is CancellationError { return UploadFailure(-32002, "cancelled") }
        switch error as? UploadImage.Failure {
        case .unsupportedImage: return UploadFailure(-32602, "unsupported_image")
        case .invalidParameters: return UploadFailure(-32602, "invalid_params")
        case .tooLarge: return UploadFailure(-32006, "image_too_large")
        case .encodingFailed: return UploadFailure(-32603, "encoding_failed")
        case nil: return UploadFailure(-32603, "network_failure")
        }
    }
}
