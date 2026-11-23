import CoreFoundation
import Foundation

/// The reference host has one synchronous method and one active session per WebView document.
final class WireHost {
    static let maxMessageBytes = 1_048_576
    static let maxInflight = 64
    private static let methodPattern = #"\A(?!rpc\.)[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+(@[1-9][0-9]*)?\z"#
    private static let requestKeys: Set<String> = ["jsonrpc", "method", "id", "params"]
    private static let echo = "conformance.echo"

    private let platform: String
    private var sid: String?
    private var handshakeIDs = Set<Data>()
    private var requestIDs = Set<Data>()

    init(platform: String) {
        self.platform = platform
    }

    func reset() {
        sid = nil
        handshakeIDs.removeAll()
        requestIDs.removeAll()
    }

    /// Called only after the adapter has authorized the current document.
    func receive(_ raw: String, exceedsInflightLimit: Bool = false) -> String? {
        guard raw.utf8.count <= Self.maxMessageBytes else { return nil }

        let value: Any
        do {
            value = try JSONSerialization.jsonObject(with: Data(raw.utf8), options: [.fragmentsAllowed])
        } catch {
            guard let sid else { return nil }
            return failure(-32700, "Parse error", id: nil, meta: ["sid": sid])
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
        if hello {
            guard register(id, handshake: true) else { return nil }
            if exceedsInflightLimit { return failure(-32008, "Rate limited", id: id, meta: responseMeta) }
            return negotiate(id: id, params: params, responseMeta: responseMeta)
        }

        // Without an established route there is no valid session to attach to an error.
        guard let sid, register(id, handshake: false) else { return nil }
        guard incomingSID == sid else { return failure(-32009, "Session expired", id: id, meta: responseMeta) }
        if exceedsInflightLimit { return failure(-32008, "Rate limited", id: id, meta: responseMeta) }
        guard method == Self.echo || method == "\(Self.echo)@1" else {
            return failure(-32601, "Method not found", id: id, meta: responseMeta)
        }
        guard let reply = response(id: id, meta: responseMeta, fields: ["result": params ?? NSDictionary()]) else {
            return failure(-32603, "Internal error", id: id, meta: responseMeta)
        }
        if reply.utf8.count > Self.maxMessageBytes {
            // An oversized request trace is unnecessary for correlating this bounded error.
            return failure(-32006, "Payload too large", id: id, meta: ["sid": sid])
        }
        return reply
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
                "methods": [Self.echo: ["versions": [1]]],
                "events": [String](),
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
