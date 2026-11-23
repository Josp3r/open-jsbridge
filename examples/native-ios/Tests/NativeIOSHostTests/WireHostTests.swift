import Foundation
import XCTest
@testable import NativeIOSHost

final class WireHostTests: XCTestCase {
    func testHandshakeIsIdempotentAndAdvertisesOnlyEcho() throws {
        let host = WireHost(platform: "ios")
        let first = try unpack(host.receive(hello(id: "first")))
        let result = try XCTUnwrap(first.rpc["result"] as? [String: Any])
        let sid = try XCTUnwrap(result["sid"] as? String)
        let capabilities = try XCTUnwrap(result["capabilities"] as? [String: Any])
        XCTAssertEqual(first.rpc["id"] as? String, "first")
        XCTAssertEqual(result["jsb"] as? String, "1.0")
        XCTAssertEqual((result["host"] as? [String: String])?["platform"], "ios")
        XCTAssertEqual(first.meta?["sid"] as? String, sid)
        XCTAssertEqual(capabilities["methods"] as? [String: [String: [Int]]], ["conformance.echo": ["versions": [1]]])
        XCTAssertEqual(capabilities["features"] as? [String], [])
        XCTAssertEqual(capabilities["events"] as? [String], [])
        XCTAssertNil(host.receive(hello(id: "first")))
        XCTAssertEqual(try session(host, id: "second"), sid)
    }

    func testRejectsUnsupportedAndInvalidHandshakeWithoutCreatingSession() throws {
        let host = WireHost(platform: "ios")
        let unsupported = try unpack(host.receive(hello(id: "unsupported", protocols: "[2]")))
        XCTAssertEqual(unsupported.error?["code"] as? Int, -32004)
        XCTAssertEqual(unsupported.error?["data"] as? [String: [Int]], ["supported": [1]])
        XCTAssertNil(unsupported.meta)
        let invalid = try unpack(host.receive(hello(id: "invalid", protocols: "[true,1]")))
        XCTAssertEqual(invalid.error?["code"] as? Int, -32602)
        XCTAssertNil(host.receive(echo(id: "too-early", sid: "forged")))
    }

    func testEchoPreservesUTF8ParamsAndRepliesOnce() throws {
        let host = WireHost(platform: "ios")
        let sid = try session(host)
        let request = echo(id: "echo", sid: sid, params: #"{"text":"你好👋","value":[true,null,1.5]}"#)
        let reply = try unpack(host.receive(request))
        XCTAssertEqual(reply.rpc["id"] as? String, "echo")
        XCTAssertEqual(reply.meta?["sid"] as? String, sid)
        XCTAssertEqual(reply.meta?["traceId"] as? String, "trace")
        XCTAssertEqual(reply.rpc["result"] as? NSDictionary, ["text": "你好👋", "value": [true, NSNull(), 1.5]] as NSDictionary)
        XCTAssertNil(host.receive(request))
    }

    func testHandshakeAndSessionCallsHaveIndependentRequestIDs() throws {
        let host = WireHost(platform: "ios")
        let sid = try session(host, id: "shared-id")
        let request = echo(id: "shared-id", sid: sid)
        let reply = try unpack(host.receive(request))
        XCTAssertNotNil(reply.rpc["result"])
        XCTAssertNil(host.receive(request))
        XCTAssertNil(host.receive(hello(id: "shared-id")))
    }

    func testResetRejectsOldSessionAndAllowsNewHandshakeID() throws {
        let host = WireHost(platform: "ios")
        let oldSID = try session(host)
        host.reset()
        XCTAssertNil(host.receive(echo(id: "replay", sid: oldSID)))
        let newSID = try session(host)
        XCTAssertNotEqual(oldSID, newSID)
        XCTAssertNil(host.receive(echo(id: "replay", sid: oldSID)))
        XCTAssertNotNil(host.receive(echo(id: "replay", sid: newSID)))
    }

    func testReturnsCorrelatedErrorsWhileDiscardingNotificationsAndResponses() throws {
        let host = WireHost(platform: "ios")
        let sid = try session(host)
        let invalid = #"{"jsb":"1.0","meta":{"sid":"\#(sid)"},"rpc":{"jsonrpc":"2.0","method":"conformance.echo","id":"invalid","params":[]}}"#
        let notification = #"{"jsb":"1.0","meta":{"sid":"\#(sid)"},"rpc":{"jsonrpc":"2.0","method":"conformance.echo","params":{}}}"#
        let response = #"{"jsb":"1.0","meta":{"sid":"\#(sid)"},"rpc":{"jsonrpc":"2.0","id":"unknown","result":null,"error":{}}}"#
        let invalidReply = try unpack(host.receive(invalid))
        XCTAssertEqual(invalidReply.rpc["id"] as? String, "invalid")
        XCTAssertEqual(invalidReply.error?["code"] as? Int, -32600)
        XCTAssertNil(host.receive(invalid))
        XCTAssertNil(host.receive(notification))
        XCTAssertNil(host.receive(response))
        let unknown = try unpack(host.receive(echo(id: "unknown", sid: sid, method: "conformance.echo@2")))
        XCTAssertEqual(unknown.error?["code"] as? Int, -32601)
        let parse = try unpack(host.receive("{"))
        XCTAssertTrue(parse.rpc["id"] is NSNull)
        XCTAssertEqual(parse.error?["code"] as? Int, -32700)
    }

    func testMissingSessionGetsCorrelatedErrorOnlyAfterHandshake() throws {
        let host = WireHost(platform: "ios")
        let raw = #"{"jsb":"1.0","rpc":{"jsonrpc":"2.0","id":"missing-session","method":"conformance.echo"}}"#
        XCTAssertNil(host.receive(raw))
        let sid = try session(host)
        let reply = try unpack(host.receive(raw))
        XCTAssertEqual(reply.rpc["id"] as? String, "missing-session")
        XCTAssertEqual(reply.meta?["sid"] as? String, sid)
        XCTAssertEqual(reply.error?["code"] as? Int, -32009)
        XCTAssertNil(host.receive(raw))
    }

    func testLimitsIncomingAndOutgoingBytes() throws {
        let host = WireHost(platform: "ios")
        let sid = try session(host)
        let input = String(repeating: "你好", count: WireHost.maxMessageBytes / 6)
        XCTAssertNil(host.receive(echo(id: "oversize", sid: sid, params: #"{"text":"\#(input)"}"#)))

        // Swift's default JSON writer escapes slashes, which could inflate otherwise small echoes.
        let raw = echo(id: "slashes", sid: sid, params: #"{"text":"\#(String(repeating: "/", count: WireHost.maxMessageBytes - 200))"}"#)
        XCTAssertLessThanOrEqual(raw.utf8.count, WireHost.maxMessageBytes)
        let response = try XCTUnwrap(host.receive(raw))
        let reply = try unpack(response)
        XCTAssertLessThanOrEqual(response.utf8.count, WireHost.maxMessageBytes)
        XCTAssertEqual((reply.rpc["result"] as? [String: String])?["text"]?.utf8.count, WireHost.maxMessageBytes - 200)
    }

    private func hello(id: String, protocols: String = "[1]") -> String {
        #"{"jsb":"1.0","rpc":{"jsonrpc":"2.0","id":"\#(id)","method":"bridge.hello","params":{"protocols":\#(protocols)}}}"#
    }

    private func echo(id: String, sid: String, params: String = "{}", method: String = "conformance.echo@1") -> String {
        #"{"jsb":"1.0","meta":{"sid":"\#(sid)","traceId":"trace"},"rpc":{"jsonrpc":"2.0","id":"\#(id)","method":"\#(method)","params":\#(params)}}"#
    }

    private func session(_ host: WireHost, id: String = "hello") throws -> String {
        let reply = try unpack(host.receive(hello(id: id)))
        return try XCTUnwrap((reply.rpc["result"] as? [String: Any])?["sid"] as? String)
    }

    private func unpack(_ raw: String?) throws -> (rpc: [String: Any], meta: [String: Any]?, error: [String: Any]?) {
        let raw = try XCTUnwrap(raw)
        let body = try JSONSerialization.jsonObject(with: Data(raw.utf8))
        let envelope = try XCTUnwrap(body as? [String: Any])
        XCTAssertEqual(envelope["jsb"] as? String, "1.0")
        let rpc = try XCTUnwrap(envelope["rpc"] as? [String: Any])
        XCTAssertEqual(rpc["jsonrpc"] as? String, "2.0")
        return (rpc, envelope["meta"] as? [String: Any], rpc["error"] as? [String: Any])
    }
}
