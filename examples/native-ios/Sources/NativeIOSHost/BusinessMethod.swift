import Foundation

public extension NativeIOSHost {
    /// Version 1 of an application-owned bridge method.
    struct BusinessMethod {
        /// The handler receives a JSON object and returns a JSON value. Use `NSNull()` for JSON null.
        public typealias Handler = @MainActor ([String: Any]) async throws -> Any

        private static let reservedNamespaces: Set<Substring> = [
            "bridge", "conformance", "ojsb", "rpc", "device", "app", "ui", "storage", "network", "media"
        ]

        let name: String
        let handler: Handler

        /// Registers a qualified name such as `acme.app.getConfig` with a version 1 handler.
        public init(_ name: String, handler: @escaping Handler) throws {
            let namespace = name.prefix(while: { $0 != "." })
            guard !Self.reservedNamespaces.contains(namespace), WireHost.isQualifiedBaseName(name) else {
                throw BusinessMethodError.invalidName(name)
            }
            self.name = name
            self.handler = handler
        }
    }

    enum BusinessMethodError: Error {
        case invalidName(String)
        case duplicateName(String)
        /// Throw this from a handler to return the protocol's `Invalid params` error.
        case invalidParams
    }
}
