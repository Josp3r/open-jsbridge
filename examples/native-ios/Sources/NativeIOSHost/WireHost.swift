import CoreFoundation
import Foundation

/// The reference host has synchronous methods and one active session per WebView document.
final class WireHost {
    private enum NetworkSubscription: Equatable {
        case pending(String)
        case subscribed
    }

    static let maxMessageBytes = 1_048_576
    static let maxInflight = 64
    private static let qualifiedName = #"\A(?!rpc\.)[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+"#
    private static let methodPattern = qualifiedName + #"(@[1-9][0-9]*)?\z"#
    private static let eventPattern = qualifiedName + #"\z"#
    private static let requestKeys: Set<String> = ["jsonrpc", "method", "id", "params"]
    private static let echo = "conformance.echo"
    private static let subscribe = "bridge.subscribe"
    private static let unsubscribe = "bridge.unsubscribe"

    private let platform: String
    private let methods: [String: [String: [Int]]]
    private let events: [String]
    private let networkType: () -> NetworkConnection
    private var networkSubscription: NetworkSubscription?
    private(set) var sid: String?
    private var handshakeIDs = Set<Data>()
    private var requestIDs = Set<Data>()

    init(platform: String, options: NativeIOSHost.Options = .init(), networkType: @escaping () -> NetworkConnection = { .unknown }) {
        self.platform = platform
        self.networkType = networkType
        var methods = [Self.echo: ["versions": [1]]]
        if options.deviceInfo { methods[DeviceModule.method] = ["versions": [1]] }
        if options.networkStatus { methods[NetworkModule.method] = ["versions": [1]] }
        self.methods = methods
        events = options.networkChanges ? [NetworkModule.event] : []
    }

    var watchesNetwork: Bool {
        sid != nil && (methods[NetworkModule.method] != nil || networkSubscription == .subscribed)
    }

    func reset() {
        sid = nil
        networkSubscription = nil
        handshakeIDs.removeAll()
        requestIDs.removeAll()
    }

    /// Called only after the adapter has authorized the current document.
    /// The adapter runs the registered callback once it has sent the acknowledgement.
    func receive(_ raw: String, exceedsInflightLimit: Bool = false,
                 afterReply: (@escaping () -> Void) -> Void = { $0() }) -> String? {
        guard raw.utf8.count <= Self.maxMessageBytes else { return nil }
        let bytes = Data(raw.utf8)
        guard !Self.hasTrailingComma(bytes) else { return parseFailure() }

        let value: Any
        do {
            value = try JSONSerialization.jsonObject(with: bytes, options: [.fragmentsAllowed])
        } catch {
            // Foundation can also fail before exposing the ID of an out-of-range number.
            // Diagnostics are optional; don't label that case a syntax error.
            guard sid != nil, !Self.hasUnrepresentableNumber(bytes) else { return nil }
            return parseFailure()
        }

        let envelope = value as? [String: Any]
        let rpc = envelope?["rpc"] as? [String: Any]
        let meta = envelope?["meta"] as? [String: Any] ?? [:]
        let method = rpc?["method"] as? String
        let id = Self.requestID(rpc?["id"])
        let incomingSID = meta["sid"] as? String
        let hello = method == "bridge.hello" || method == "bridge.hello@1"

        // Neither notification-like frames nor response-like frames get a response.
        if let rpc, rpc["method"] == nil || rpc["id"] == nil { return nil }
        if let incomingSID, !incomingSID.isEmpty, incomingSID != sid { return nil }

        var responseMeta: [String: String] = [:]
        if let sid { responseMeta["sid"] = sid }
        if let trace = meta["traceId"] as? String { responseMeta["traceId"] = trace }

        guard envelope?["jsb"] as? String == "1.0",
              let rpc, rpc["jsonrpc"] as? String == "2.0",
              Set(rpc.keys).isSubset(of: Self.requestKeys),
              let method, method.range(of: Self.methodPattern, options: .regularExpression) != nil,
              let id,
              rpc["params"] == nil || rpc["params"] is NSDictionary,
              Self.validMeta(envelope?["meta"]),
              Self.isPortableJSON(value)
        else {
            guard sid != nil || (hello && id != nil && meta["sid"] == nil) else { return nil }
            if let id, !register(id, handshake: hello) { return nil }
            return failure(-32600, "Invalid request", id: id, meta: responseMeta)
        }

        let params = rpc["params"] as? NSDictionary
        let zeroTimeout = meta["timeout"].flatMap(Self.safeInteger) == 0
        if hello {
            guard register(id, handshake: true) else { return nil }
            if exceedsInflightLimit { return failure(-32008, "Rate limited", id: id, meta: responseMeta) }
            if zeroTimeout { return failure(-32602, "Invalid request timeout", id: id, meta: responseMeta) }
            return negotiate(id: id, params: params, responseMeta: responseMeta)
        }

        // Without an established route there is no valid session to attach to an error.
        guard let sid, register(id, handshake: false) else { return nil }
        guard incomingSID == sid else { return failure(-32009, "Session expired", id: id, meta: responseMeta) }
        if exceedsInflightLimit { return failure(-32008, "Rate limited", id: id, meta: responseMeta) }
        let name = method.hasSuffix("@1") ? String(method.dropLast(2)) : method
        guard methods[name] != nil || name == Self.subscribe || name == Self.unsubscribe else {
            return failure(-32601, "Method not found", id: id, meta: responseMeta)
        }
        if zeroTimeout { return failure(-32602, "Invalid request timeout", id: id, meta: responseMeta) }

        let result: Any
        var enablesNetworkChanges = false
        var disablesNetworkChanges = false
        switch name {
        case Self.subscribe, Self.unsubscribe:
            guard let requested = Self.eventNames(params) else {
                return failure(-32602, "Invalid events", id: id, meta: responseMeta)
            }
            if name == Self.subscribe {
                let subscribed = requested.filter(events.contains)
                result = ["subscribed": subscribed, "denied": requested.filter { !events.contains($0) }]
                enablesNetworkChanges = subscribed.contains(NetworkModule.event)
            } else {
                result = ["unsubscribed": requested]
                disablesNetworkChanges = requested.contains(NetworkModule.event)
            }
        case DeviceModule.method, NetworkModule.method:
            guard params == nil || params?.count == 0 else {
                return failure(-32602, "Invalid params", id: id, meta: responseMeta)
            }
            result = name == DeviceModule.method ? DeviceModule.information() : networkType().payload
        default:
            result = params ?? NSDictionary()
        }

        guard let reply = response(id: id, meta: responseMeta, fields: ["result": result]) else {
            return failure(-32603, "Internal error", id: id, meta: responseMeta)
        }
        if reply.utf8.count > Self.maxMessageBytes {
            // An oversized request trace is unnecessary for correlating this bounded error.
            return failure(-32006, "Payload too large", id: id, meta: ["sid": sid])
        }
        if enablesNetworkChanges {
            if networkSubscription == nil { networkSubscription = .pending(id) }
            if case let .pending(subscriptionID) = networkSubscription {
                afterReply { [weak self] in
                    guard let self, self.sid == sid, self.networkSubscription == .pending(subscriptionID) else { return }
                    self.networkSubscription = .subscribed
                }
            }
        } else if disablesNetworkChanges {
            networkSubscription = nil
        }
        return reply
    }

    func networkEvent(_ type: NetworkConnection, for sid: String) -> String? {
        guard self.sid == sid, networkSubscription == .subscribed else { return nil }
        return serialize(rpc: [
            "jsonrpc": "2.0",
            "method": "bridge.event",
            "params": ["name": NetworkModule.event, "payload": type.payload]
        ], meta: ["sid": sid])
    }

    private static func eventNames(_ params: NSDictionary?) -> [String]? {
        guard let events = params?["events"] as? [String], !events.isEmpty, Set(events).count == events.count,
              events.allSatisfy({ $0.range(of: eventPattern, options: .regularExpression) != nil }) else { return nil }
        return events
    }

    private func parseFailure() -> String? {
        guard let sid else { return nil }
        return failure(-32700, "Parse error", id: nil, meta: ["sid": sid])
    }

    private static func containsUnquotedByte(in bytes: Data, where predicate: (Int) -> Bool) -> Bool {
        var quoted = false
        var escaped = false
        for (index, byte) in bytes.enumerated() {
            if quoted {
                if escaped { escaped = false }
                else if byte == 0x5c { escaped = true }
                else if byte == 0x22 { quoted = false }
            } else if byte == 0x22 {
                quoted = true
            } else if predicate(index) {
                return true
            }
        }
        return false
    }

    private static func isJSONWhitespace(_ byte: UInt8) -> Bool {
        byte == 0x20 || byte == 0x09 || byte == 0x0a || byte == 0x0d
    }

    private static func hasTrailingComma(_ bytes: Data) -> Bool {
        // Foundation accepts trailing commas, unlike the JSON grammar.
        containsUnquotedByte(in: bytes) { index in
            guard bytes[index] == 0x2c else { return false }
            var next = index + 1
            while next < bytes.count && isJSONWhitespace(bytes[next]) { next += 1 }
            return next < bytes.count && (bytes[next] == 0x7d || bytes[next] == 0x5d)
        }
    }

    private static func isNumberByte(_ byte: UInt8) -> Bool {
        switch byte {
        case 0x30...0x39, 0x2b, 0x2d, 0x2e, 0x45, 0x65: return true
        default: return false
        }
    }

    private static func hasUnrepresentableNumber(_ bytes: Data) -> Bool {
        // Only called after a parse failure. An unrepresentable or ambiguous numeric
        // token is enough to withhold the optional diagnostic; no token is repaired.
        var numberEnd = 0
        return containsUnquotedByte(in: bytes) { start in
            guard start >= numberEnd, bytes[start] == 0x2d || (0x30...0x39).contains(bytes[start]) else {
                return false
            }
            var end = start + 1
            while end < bytes.count && isNumberByte(bytes[end]) { end += 1 }
            numberEnd = end
            return Double(String(decoding: bytes[start..<end], as: UTF8.self))?.isFinite != true
        }
    }

    private func register(_ id: String, handshake: Bool) -> Bool {
        let key = Data(id.utf8)
        if handshake { return handshakeIDs.insert(key).inserted }
        return requestIDs.insert(key).inserted
    }

    private func negotiate(id: String, params: NSDictionary?, responseMeta: [String: String]) -> String? {
        guard let protocols = params?["protocols"] as? [Any], !protocols.isEmpty,
              Self.validHelloOptionalFields(params)
        else {
            return failure(-32602, "Invalid handshake params", id: id, meta: responseMeta)
        }
        var majors = Set<Int64>()
        for item in protocols {
            guard let major = Self.safeInteger(item), major > 0, majors.insert(major).inserted else {
                return failure(-32602, "Invalid handshake params", id: id, meta: responseMeta)
            }
        }
        guard majors.contains(1) else {
            return failure(-32004, "Unsupported protocol", id: id, meta: responseMeta, data: ["supported": [1]])
        }

        let sid = self.sid ?? UUID().uuidString.lowercased()
        self.sid = sid
        let result: [String: Any] = [
            "jsb": "1.0",
            "sid": sid,
            "host": ["platform": platform, "name": "ios-wk", "version": "0.1.0"],
            "capabilities": [
                "methods": methods,
                "events": events,
                "features": [String]()
            ],
            "limits": ["maxMessageBytes": Self.maxMessageBytes, "maxInflight": Self.maxInflight, "defaultTimeoutMs": 15_000]
        ]
        var meta = responseMeta
        meta["sid"] = sid
        if let reply = response(id: id, meta: meta, fields: ["result": result]),
           reply.utf8.count <= Self.maxMessageBytes {
            return reply
        }
        return response(id: id, meta: ["sid": sid], fields: ["result": result])
    }

    private func failure(_ code: Int, _ message: String, id: String?, meta: [String: String], data: [String: Any]? = nil) -> String? {
        var error: [String: Any] = ["code": code, "message": message]
        if let data { error["data"] = data }
        if let reply = response(id: id, meta: meta, fields: ["error": error]),
           reply.utf8.count <= Self.maxMessageBytes { return reply }
        return response(id: id, meta: meta.filter { $0.key == "sid" }, fields: ["error": error])
    }

    private func response(id: String?, meta: [String: String], fields: [String: Any]) -> String? {
        var rpc = fields
        rpc["jsonrpc"] = "2.0"
        rpc["id"] = id as Any? ?? NSNull()
        return serialize(rpc: rpc, meta: meta)
    }

    private func serialize(rpc: [String: Any], meta: [String: String]) -> String? {
        var envelope: [String: Any] = ["jsb": "1.0", "rpc": rpc]
        if !meta.isEmpty { envelope["meta"] = meta }
        guard let data = try? JSONSerialization.data(withJSONObject: envelope, options: [.withoutEscapingSlashes]) else {
            return nil
        }
        return String(decoding: data, as: UTF8.self)
    }

    private static func requestID(_ value: Any?) -> String? {
        guard let id = value as? String, (1...128).contains(id.unicodeScalars.count) else { return nil }
        return id
    }

    private static func validMeta(_ value: Any?) -> Bool {
        guard let value else { return true }
        guard let meta = value as? [String: Any] else { return false }
        if let sid = meta["sid"], (sid as? String)?.isEmpty != false { return false }
        if let trace = meta["traceId"], !(trace is String) { return false }
        for key in ["timeout", "ts"] {
            if let number = meta[key], (safeInteger(number) ?? -1) < 0 { return false }
        }
        return true
    }

    private static func validHelloOptionalFields(_ params: NSDictionary?) -> Bool {
        if let value = params?["sdk"] {
            guard let sdk = value as? [String: Any], sdk["name"] is String, sdk["version"] is String else { return false }
        }
        if let value = params?["wants"] {
            guard let wants = value as? [String], Set(wants.map { Data($0.utf8) }).count == wants.count else { return false }
        }
        return true
    }

    private static func safeInteger(_ value: Any) -> Int64? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard abs(double) <= 9_007_199_254_740_991, double.rounded(.towardZero) == double else { return nil }
        return Int64(double)
    }

    private static func isPortableJSON(_ value: Any) -> Bool {
        if let object = value as? NSDictionary { return object.allValues.allSatisfy(isPortableJSON) }
        if let array = value as? [Any] { return array.allSatisfy(isPortableJSON) }
        if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            let value = number.doubleValue
            return value.isFinite && (value.rounded(.towardZero) != value || abs(value) <= 9_007_199_254_740_991)
        }
        return true
    }
}
