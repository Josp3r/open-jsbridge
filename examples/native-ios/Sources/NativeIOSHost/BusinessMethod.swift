import Foundation

public extension NativeIOSHost {
    /// Version 1 of an application-owned bridge method.
    struct BusinessMethod {
        /// The handler receives a JSON object and returns a JSON value. Use `NSNull()` for JSON null.
        public typealias Handler = @MainActor ([String: Any]) async throws -> Any
        public typealias StreamingHandler = @MainActor ([String: Any], ProgressReporter) async throws -> Any

        private static let reservedNamespaces: Set<Substring> = [
            "bridge", "conformance", "ojsb", "rpc", "device", "app", "ui", "storage", "network", "media"
        ]

        let name: String
        let handler: StreamingHandler
        let supportsCallbacks: Bool

        /// Registers a qualified name such as `acme.app.getConfig` with a version 1 handler.
        public init(_ name: String, handler: @escaping Handler) throws {
            try self.init(name, supportsCallbacks: false) { params, _ in try await handler(params) }
        }

        /// Registers a method whose schema declares `x-ojsb-callbacks`.
        public init(_ name: String, streaming: @escaping StreamingHandler) throws {
            try self.init(name, supportsCallbacks: true, handler: streaming)
        }

        private init(_ name: String, supportsCallbacks: Bool, handler: @escaping StreamingHandler) throws {
            guard name != UploadRequest.method, Self.isAllowedName(name) else {
                throw BusinessMethodError.invalidName(name)
            }
            self.name = name
            self.supportsCallbacks = supportsCallbacks
            self.handler = handler
        }

        static func isAllowedName(_ name: String) -> Bool {
            let namespace = name.prefix(while: { $0 != "." })
            return !Self.reservedNamespaces.contains(namespace) && WireHost.isQualifiedBaseName(name)
        }
    }

    /// Reports progress for one request in its original document.
    @MainActor
    final class ProgressReporter {
        private let deliver: @MainActor (Any?) async -> Bool
        private var sending = false
        private var afterSend: (() -> Void)?

        init(deliver: @escaping @MainActor (Any?) async -> Bool) {
            self.deliver = deliver
        }

        /// Await each send. Overlapping sends are declined. Use NSNull() for an explicit JSON null.
        @discardableResult
        public func send(_ chunk: Any? = nil) async -> Bool {
            guard !sending else { return false }
            sending = true
            defer {
                sending = false
                let completion = afterSend
                afterSend = nil
                completion?()
            }
            return await deliver(chunk)
        }

        // The final WithReply must follow even a send started by a child task of the handler.
        func whenDrained(_ completion: @escaping () -> Void) {
            if sending { afterSend = completion } else { completion() }
        }
    }

    enum BusinessMethodError: Error {
        case invalidName(String)
        case duplicateName(String)
        /// Throw this from a handler to return the protocol's `Invalid params` error.
        case invalidParams
    }
}
