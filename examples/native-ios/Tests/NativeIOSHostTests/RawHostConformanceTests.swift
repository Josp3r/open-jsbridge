import CoreFoundation
import Foundation
import XCTest
@testable import NativeIOSHost

final class RawHostConformanceTests: XCTestCase {
    func testSharedInboundRawFrames() throws {
        let root = (0..<5).reduce(URL(fileURLWithPath: #filePath)) { url, _ in
            url.deletingLastPathComponent()
        }
        let fixtureURL = root.appendingPathComponent("conformance-tests/fixtures/host-inbound-raw.json")
        let fixture = try JSONValue.parse(Data(contentsOf: fixtureURL))
        guard fixture["version"] == .number(NSNumber(value: 1)),
              let bootstrapJSON = fixture["bootstrap"],
              case let .array(cases)? = fixture["cases"], !cases.isEmpty else {
            throw FixtureError("Expected a v1 fixture with bootstrap and nonempty cases")
        }
        let bootstrap = try Step(bootstrapJSON)
        for scenario in cases {
            guard let name = scenario["name"]?.text,
                  let initial = scenario["initial"]?.text,
                  case let .array(steps)? = scenario["steps"], !steps.isEmpty else {
                throw FixtureError("Expected a case with name, initial, and nonempty steps")
            }
            XCTContext.runActivity(named: name) { _ in
                do {
                    var sid: String?
                    var oldSID: String?
                    let host = WireHost(platform: "ios")
                    switch initial {
                    case "fresh": break
                    case "active": sid = try establish(host, bootstrap: bootstrap, label: "bootstrap")
                    case "replaced":
                        let previous = try establish(WireHost(platform: "ios"), bootstrap: bootstrap, label: "old bootstrap")
                        let current = try establish(host, bootstrap: bootstrap, label: "current bootstrap")
                        guard !previous.utf8.elementsEqual(current.utf8) else {
                            throw FixtureError("Independent cores returned the same SID")
                        }
                        oldSID = previous
                        sid = current
                    default: throw FixtureError("Unknown initial state: \(initial)")
                    }
                    for (index, step) in steps.enumerated() {
                        try check(Step(step), on: host, sid: &sid, oldSID: oldSID, label: "\(name): step \(index + 1)")
                    }
                } catch {
                    XCTFail("\(name): \(error.localizedDescription)")
                }
            }
        }
    }

    private func establish(_ host: WireHost, bootstrap: Step, label: String) throws -> String {
        var sid: String?
        try check(bootstrap, on: host, sid: &sid, oldSID: nil, label: label)
        guard let sid else { throw FixtureError("\(label) did not establish a session") }
        return sid
    }

    private func check(_ step: Step, on host: WireHost, sid: inout String?, oldSID: String?, label: String) throws {
        let raw = try substituteSIDs(in: step.raw, sid: sid, oldSID: oldSID)
        let replyText = host.receive(raw)
        let reply: JSONValue?
        do {
            reply = try replyText.map { try JSONValue.parse(Data($0.utf8)) }
        } catch {
            XCTFail("\(label): invalid JSON reply for \(step.raw): \(replyText ?? "<no reply>")")
            return
        }
        guard let accepted = step.accept.first(where: { $0.matches(reply, currentSID: sid) }) else {
            XCTFail("\(label): unexpected reply for \(step.raw): \(replyText ?? "<no RPC reply>")")
            return
        }
        if case .hello = accepted {
            sid = reply?["rpc"]?["result"]?["sid"]?.text
        }
    }

    /// Replace only entire quoted string tokens, without parsing or reserializing the frame.
    private func substituteSIDs(in raw: String, sid: String?, oldSID: String?) throws -> String {
        let bytes = Array(raw.utf8)
        var output: [UInt8] = []
        var index = 0
        while index < bytes.count {
            guard bytes[index] == 0x22 else {
                output.append(bytes[index])
                index += 1
                continue
            }
            let start = index
            index += 1
            while index < bytes.count {
                let byte = bytes[index]
                index += 1
                if byte == 0x22 { break }
                if byte == 0x5c, index < bytes.count { index += 1 }
            }
            let token = bytes[start..<index]
            let replacement: String?
            if token.elementsEqual(#""$SID""#.utf8) {
                guard let sid else { throw FixtureError("$SID used before it was bound") }
                replacement = sid
            } else if token.elementsEqual(#""$OLD_SID""#.utf8) {
                guard let oldSID else { throw FixtureError("$OLD_SID used before it was bound") }
                replacement = oldSID
            } else {
                replacement = nil
            }
            if let replacement {
                output.append(contentsOf: try JSONEncoder().encode(replacement))
            } else {
                output.append(contentsOf: token)
            }
        }
        return String(decoding: output, as: UTF8.self)
    }

    private struct Step {
        let raw: String
        let accept: [Acceptance]

        init(_ json: JSONValue) throws {
            guard let raw = json["raw"]?.text,
                  case let .array(accept)? = json["accept"], !accept.isEmpty else {
                throw FixtureError("Expected a step with raw text and nonempty accept alternatives")
            }
            self.raw = raw
            self.accept = try accept.map(Acceptance.init)
        }
    }

    private enum Acceptance {
        case none
        case hello(id: JSONValue)
        case result(id: JSONValue, sid: SID, value: JSONValue)
        case error(id: JSONValue, sid: SID, code: JSONValue, data: JSONValue?)

        init(_ json: JSONValue) throws {
            let kind = json["kind"]?.text
            if kind == "none" { self = .none; return }
            guard let id = json["id"], id == .null || id.text != nil,
                  let sid = json["sid"] else {
                throw FixtureError("Expected explicit id and sid for a reply alternative")
            }
            switch kind {
            case "hello":
                guard id.text != nil, sid == .string("$SID") else {
                    throw FixtureError("Expected a string hello id and $SID binding")
                }
                self = .hello(id: id)
            case "result":
                guard let value = json["value"] else { throw FixtureError("Missing expected result value") }
                self = .result(id: id, sid: try SID(sid), value: value)
            case "error":
                guard case .number? = json["code"], let code = json["code"] else {
                    throw FixtureError("Expected a numeric error code")
                }
                self = .error(id: id, sid: try SID(sid), code: code, data: json["data"])
            default: throw FixtureError("Unknown acceptance kind: \(kind ?? "<missing>")")
            }
        }

        func matches(_ reply: JSONValue?, currentSID: String?) -> Bool {
            if case .none = self { return reply == nil }
            guard let reply, reply["jsb"] == .string("1.0"),
                  let rpc = reply["rpc"], rpc["jsonrpc"] == .string("2.0"), rpc["method"] == nil else {
                return false
            }
            let meta = reply["meta"]
            if let meta {
                guard case .object = meta else { return false }
            }
            let actualSID = meta?["sid"]
            switch self {
            case .none: return false
            case let .hello(id):
                guard rpc["id"] == id, rpc["error"] == nil,
                      let result = rpc["result"], result["jsb"] == .string("1.0"),
                      let binding = result["sid"], let text = binding.text, !text.isEmpty,
                      currentSID.map({ binding == .string($0) }) ?? true else { return false }
                return actualSID == nil || actualSID == binding
            case let .result(id, sid, value):
                return rpc["id"] == id && rpc["error"] == nil && rpc["result"] == value &&
                    sid.matches(actualSID, current: currentSID)
            case let .error(id, sid, code, data):
                guard rpc["id"] == id, rpc["result"] == nil,
                      let error = rpc["error"], error["code"] == code, error["message"]?.text != nil,
                      sid.matches(actualSID, current: currentSID) else { return false }
                return data.map { error["data"] == $0 } ?? true
            }
        }
    }

    private enum SID {
        case current, absent

        init(_ json: JSONValue) throws {
            if json == .string("$SID") { self = .current }
            else if json == .null { self = .absent }
            else { throw FixtureError("Expected $SID or null for reply metadata") }
        }

        func matches(_ actual: JSONValue?, current: String?) -> Bool {
            switch self {
            case .current: return current.map { actual == .string($0) } ?? false
            case .absent: return actual == nil
            }
        }
    }

    private indirect enum JSONValue: Equatable {
        case null, boolean(Bool), number(NSNumber), textBytes(Data)
        case array([JSONValue]), object([Data: JSONValue])

        static func string(_ text: String) -> JSONValue { .textBytes(Data(text.utf8)) }

        var text: String? {
            guard case let .textBytes(bytes) = self else { return nil }
            return String(decoding: bytes, as: UTF8.self)
        }

        subscript(_ key: String) -> JSONValue? {
            guard case let .object(fields) = self else { return nil }
            return fields[Data(key.utf8)]
        }

        static func parse(_ data: Data) throws -> JSONValue {
            try JSONValue(JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]))
        }

        private init(_ value: Any) throws {
            switch value {
            case let object as NSDictionary:
                var fields: [Data: JSONValue] = [:]
                for (key, value) in object {
                    guard let key = key as? String else { throw FixtureError("Non-string JSON object key") }
                    // Swift String equality is canonically equivalent; compare keys and strings as UTF-8.
                    fields[Data(key.utf8)] = try JSONValue(value)
                }
                self = .object(fields)
            case let array as NSArray: self = .array(try array.map(JSONValue.init))
            case let text as String: self = .string(text)
            case let number as NSNumber:
                self = CFGetTypeID(number) == CFBooleanGetTypeID() ? .boolean(number.boolValue) : .number(number)
            case is NSNull: self = .null
            default: throw FixtureError("Unsupported JSON value: \(type(of: value))")
            }
        }
    }

    private struct FixtureError: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }
}
