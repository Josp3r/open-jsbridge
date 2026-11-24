import Foundation
import Network
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

    func testSubscriptionControlsDenyUnavailableEventsAndValidateNames() throws {
        let host = WireHost(platform: "ios")
        let sid = try session(host)
        let events = #"{"events":["network.changed","app.didBecomeActive"]}"#
        let subscribe = try unpack(host.receive(echo(id: "subscribe", sid: sid, params: events, method: "bridge.subscribe@1")))
        XCTAssertEqual(subscribe.rpc["result"] as? [String: [String]], [
            "subscribed": [], "denied": ["network.changed", "app.didBecomeActive"]
        ])
        let unsubscribe = try unpack(host.receive(echo(id: "unsubscribe", sid: sid, params: events, method: "bridge.unsubscribe")))
        XCTAssertEqual(unsubscribe.rpc["result"] as? [String: [String]], [
            "unsubscribed": ["network.changed", "app.didBecomeActive"]
        ])

        for (index, invalid) in ["{}", #"{"events":[]}"#, #"{"events":["network.changed","network.changed"]}"#,
                                 #"{"events":["rpc.event"]}"#, #"{"events":["network.changed@1"]}"#,
                                 #"{"events":["network.changed\n"]}"#, #"{"events":["network.changed",1]}"#].enumerated() {
            for method in ["bridge.subscribe", "bridge.unsubscribe"] {
                let result = try unpack(host.receive(echo(id: "\(method)-\(index)", sid: sid, params: invalid, method: method)))
                XCTAssertEqual(result.error?["code"] as? Int, -32602)
            }
        }
    }

    func testProfilesAdvertiseAndDispatchOnlyConfiguredCapabilities() throws {
        let methods = ["conformance.echo": ["versions": [1]], "device.getInfo": ["versions": [1]]]
        let device = WireHost(platform: "ios", options: .init(deviceInfo: true))
        let hello = try unpack(device.receive(hello(id: "device")))
        let session = try XCTUnwrap(hello.rpc["result"] as? [String: Any])
        let sid = try XCTUnwrap(session["sid"] as? String)
        let capabilities = try XCTUnwrap(session["capabilities"] as? [String: Any])
        XCTAssertEqual(capabilities["methods"] as? [String: [String: [Int]]], methods)
        XCTAssertEqual(capabilities["events"] as? [String], [])
        let raw = #"{"jsb":"1.0","meta":{"sid":"\#(sid)"},"rpc":{"jsonrpc":"2.0","id":"info","method":"device.getInfo"}}"#
        let info = try XCTUnwrap(unpack(device.receive(raw)).rpc["result"] as? [String: String])
        XCTAssertEqual(Set(info.keys), ["os", "osVersion"])
        XCTAssertEqual(info["os"], "ios")
        XCTAssertFalse(try XCTUnwrap(info["osVersion"]).isEmpty)
        XCTAssertEqual(try unpack(device.receive(echo(id: "disabled", sid: sid, method: "network.getStatus"))).error?["code"] as? Int, -32601)

        let network = WireHost(platform: "ios", options: .init(networkStatus: true), networkType: { .ethernet })
        let networkSID = try self.session(network)
        let status = try unpack(network.receive(echo(id: "status", sid: networkSID, method: "network.getStatus@1")))
        XCTAssertEqual(status.rpc["result"] as? [String: String], ["type": "ethernet"])
        XCTAssertEqual(try unpack(network.receive(echo(id: "disabled", sid: networkSID, method: "device.getInfo"))).error?["code"] as? Int, -32601)
        let controls = try unpack(network.receive(echo(id: "events", sid: networkSID, params: #"{"events":["network.changed"]}"#, method: "bridge.subscribe")))
        XCTAssertEqual(controls.rpc["result"] as? [String: [String]], ["subscribed": [], "denied": ["network.changed"]])
    }

    func testProfileMethodsRejectUnexpectedParamsAndUnsupportedVersions() throws {
        let host = WireHost(platform: "ios", options: .init(deviceInfo: true, networkStatus: true))
        let sid = try session(host)
        for method in ["device.getInfo", "network.getStatus"] {
            for (index, invalid) in [("{\"extra\":1}", -32602), ("[]", -32600), ("null", -32600)].enumerated() {
                let error = try unpack(host.receive(echo(id: "\(method)-\(index)", sid: sid, params: invalid.0, method: method)))
                XCTAssertEqual(error.error?["code"] as? Int, invalid.1)
            }
            let error = try unpack(host.receive(echo(id: "\(method)-v2", sid: sid, method: "\(method)@2")))
            XCTAssertEqual(error.error?["code"] as? Int, -32601)
        }
    }

    func testBusinessNamesRequireAQualifiedBaseOutsideReservedNamespaces() throws {
        for name in ["acme.getConfig", "acme.app.getConfig", "com.acme.getConfig", "bridgeApps.getConfig"] {
            let method = try NativeIOSHost.BusinessMethod(name) { _ in NSNull() }
            XCTAssertEqual(method.name, name)
        }

        for name in ["", "getConfig", "Acme.getConfig", "acme.GetConfig", "acme..getConfig",
                     "acme.getConfig@1", "acme.getConfig\n", "acme.get_config", "acme.功能",
                     "bridge.other", "conformance.echo", "ojsb.test", "rpc.test", "device.other",
                     "app.other", "ui.other", "storage.other", "network.other", "media.other"] {
            XCTAssertThrowsError(try NativeIOSHost.BusinessMethod(name) { _ in NSNull() }) { error in
                guard let error = error as? NativeIOSHost.BusinessMethodError,
                      case let .invalidName(actual) = error else { return XCTFail("Unexpected error: \(error)") }
                XCTAssertEqual(actual, name)
            }
        }
    }

    func testHelloAdvertisesBusinessMethodsWithoutEchoWhenDisabled() throws {
        let name = "acme.app.getConfig"
        let host = WireHost(platform: "ios", options: .init(deviceInfo: true),
                            businessMethods: [name: { _ in NSNull() }], enableEcho: false)
        let reply = try unpack(host.receive(hello(id: "hello")))
        let result = try XCTUnwrap(reply.rpc["result"] as? [String: Any])
        let capabilities = try XCTUnwrap(result["capabilities"] as? [String: Any])
        XCTAssertEqual(capabilities["methods"] as? [String: [String: [Int]]], [
            "device.getInfo": ["versions": [1]], "acme.app.getConfig": ["versions": [1]]
        ])
        let sid = try XCTUnwrap(result["sid"] as? String)
        for method in ["conformance.echo", "acme.app.other"] {
            let reply = try unpack(host.receive(echo(id: method, sid: sid, method: method)))
            XCTAssertEqual(reply.error?["code"] as? Int, -32601)
        }
    }

    func testHelloKeepsOversizedCapabilityAdvertisementWithinTheWireLimit() throws {
        let name = "acme." + String(repeating: "a", count: WireHost.maxMessageBytes)
        let host = WireHost(platform: "ios", businessMethods: [name: { _ in NSNull() }], enableEcho: false)
        let raw = try XCTUnwrap(host.receive(hello(id: "hello")))
        let reply = try unpack(raw)
        XCTAssertLessThanOrEqual(raw.utf8.count, WireHost.maxMessageBytes)
        XCTAssertEqual(reply.rpc["id"] as? String, "hello")
        XCTAssertEqual(reply.error?["code"] as? Int, -32006)
        XCTAssertNil(host.sid)
    }

    @MainActor
    func testBusinessV1RequestsDeferAndDecodeObjectParams() async throws {
        let method = try NativeIOSHost.BusinessMethod("acme.app.getConfig") { params in
            ["input": params, "extra": [true, NSNull(), 1.5]]
        }
        let host = WireHost(platform: "ios", businessMethods: [method.name: method.handler])
        let sid = try session(host)
        let requests = [
            #"{"jsb":"1.0","meta":{"sid":"\#(sid)","traceId":"trace"},"rpc":{"jsonrpc":"2.0","id":"base","method":"acme.app.getConfig"}}"#,
            echo(id: "v1", sid: sid, params: #"{"locale":"中文"}"#, method: "acme.app.getConfig@1")
        ]
        for (index, request) in requests.enumerated() {
            var call: WireHost.BusinessCall?
            XCTAssertNil(host.receive(request, onBusinessCall: { call = $0 }))
            let deferred = try XCTUnwrap(call)
            let result = try await deferred.handler(deferred.params)
            let reply = try unpack(host.finishBusinessCall(deferred, result: .success(result)))
            XCTAssertEqual(reply.rpc["id"] as? String, index == 0 ? "base" : "v1")
            XCTAssertEqual(reply.meta?["sid"] as? String, sid)
            XCTAssertEqual(reply.meta?["traceId"] as? String, "trace")
            XCTAssertEqual(reply.rpc["result"] as? NSDictionary, [
                "input": index == 0 ? [:] : ["locale": "中文"], "extra": [true, NSNull(), 1.5]
            ] as NSDictionary)
        }
    }

    func testBusinessDispatchRespectsVersionAndRequestAdmission() throws {
        let method = "acme.getConfig"
        let host = WireHost(platform: "ios", businessMethods: [method: { _ in NSNull() }])
        var dispatched = 0
        let receive: (WireHost.BusinessCall) -> Void = { _ in dispatched += 1 }
        let early = echo(id: "early", sid: "wrong", method: method)
        XCTAssertNil(host.receive(early, onBusinessCall: receive))
        let sid = try session(host)
        XCTAssertNil(host.receive(early, onBusinessCall: receive))

        let request = echo(id: "id", sid: sid, method: method)
        XCTAssertNil(host.receive(request, onBusinessCall: receive))
        XCTAssertNil(host.receive(request, onBusinessCall: receive))
        let cases = [
            (echo(id: "version", sid: sid, method: "\(method)@2"), false, -32601),
            (echo(id: "limit", sid: sid, method: method), true, -32008),
            (echo(id: "params", sid: sid, params: "[]", method: method), false, -32600),
            (#"{"jsb":"1.0","rpc":{"jsonrpc":"2.0","id":"no-sid","method":"\#(method)"}}"#, false, -32009),
            (#"{"jsb":"1.0","meta":{"sid":"\#(sid)","timeout":0},"rpc":{"jsonrpc":"2.0","id":"timeout","method":"\#(method)"}}"#, false, -32602)
        ]
        for (raw, atLimit, code) in cases {
            let reply = try unpack(host.receive(raw, exceedsInflightLimit: atLimit, onBusinessCall: receive))
            XCTAssertEqual(reply.error?["code"] as? Int, code)
        }
        XCTAssertEqual(dispatched, 1)
    }

    func testBusinessFailuresReturnBoundedCorrelatedErrors() throws {
        struct AppFailure: LocalizedError {
            var errorDescription: String? { "private app data" }
        }

        let method = "acme.getConfig"
        let host = WireHost(platform: "ios", businessMethods: [method: { _ in NSNull() }])
        let sid = try session(host)
        let cases: [(Result<Any, Error>, Int, String)] = [
            (.failure(NativeIOSHost.BusinessMethodError.invalidParams), -32602, "Invalid params"),
            (.failure(AppFailure()), -32603, "Internal error"),
            (.success(Date(timeIntervalSince1970: 0)), -32603, "Internal error"),
            (.success(["value": Double.nan]), -32603, "Internal error"),
            (.success([9_007_199_254_740_992 as Int64]), -32603, "Internal error"),
            (.success(String(repeating: "界", count: WireHost.maxMessageBytes / 2)), -32006, "Payload too large")
        ]
        for (index, entry) in cases.enumerated() {
            let id = "failure-\(index)"
            var call: WireHost.BusinessCall?
            XCTAssertNil(host.receive(echo(id: id, sid: sid, method: method), onBusinessCall: { call = $0 }))
            let raw = try XCTUnwrap(host.finishBusinessCall(XCTUnwrap(call), result: entry.0))
            let reply = try unpack(raw)
            XCTAssertLessThanOrEqual(raw.utf8.count, WireHost.maxMessageBytes)
            XCTAssertEqual(reply.rpc["id"] as? String, id)
            XCTAssertEqual(reply.meta?["sid"] as? String, sid)
            XCTAssertEqual(reply.error?["code"] as? Int, entry.1)
            XCTAssertEqual(reply.error?["message"] as? String, entry.2)
            XCTAssertNil(reply.error?["data"])
        }
    }

    func testBusinessCompletionIsDiscardedAfterItsSessionResets() throws {
        let method = "acme.getConfig"
        let host = WireHost(platform: "ios", businessMethods: [method: { _ in NSNull() }])
        let oldSID = try session(host)
        var oldCall: WireHost.BusinessCall?
        XCTAssertNil(host.receive(echo(id: "config", sid: oldSID, method: method), onBusinessCall: { oldCall = $0 }))
        let old = try XCTUnwrap(oldCall)
        host.reset()
        XCTAssertNil(host.finishBusinessCall(old, result: .success("stale")))

        let sid = try session(host)
        var currentCall: WireHost.BusinessCall?
        XCTAssertNil(host.receive(echo(id: "config", sid: sid, method: method), onBusinessCall: { currentCall = $0 }))
        XCTAssertNil(host.finishBusinessCall(old, result: .success("still stale")))
        let reply = try unpack(host.finishBusinessCall(XCTUnwrap(currentCall), result: .success(NSNull())))
        XCTAssertEqual(reply.meta?["sid"] as? String, sid)
        XCTAssertTrue(reply.rpc["result"] is NSNull)
    }

    func testNetworkPushWaitsForAcknowledgementAndIsScopedToSession() throws {
        let host = WireHost(platform: "ios", options: .init(networkChanges: true))
        let hello = try unpack(host.receive(hello(id: "push")))
        let session = try XCTUnwrap(hello.rpc["result"] as? [String: Any])
        let sid = try XCTUnwrap(session["sid"] as? String)
        let capabilities = try XCTUnwrap(session["capabilities"] as? [String: Any])
        XCTAssertEqual(capabilities["events"] as? [String], ["network.changed"])
        XCTAssertEqual(capabilities["features"] as? [String], [])
        XCTAssertEqual(try unpack(host.receive(echo(id: "status-disabled", sid: sid, method: "network.getStatus"))).error?["code"] as? Int, -32601)
        XCTAssertNil(host.networkEvent(.wifi, for: sid))

        let events = #"{"events":["network.changed","app.didBecomeActive"]}"#
        var firstAcknowledgement: (() -> Void)?
        let subscription = try unpack(host.receive(
            echo(id: "subscribe", sid: sid, params: events, method: "bridge.subscribe"),
            afterReply: { firstAcknowledgement = $0 }
        ))
        XCTAssertEqual(subscription.rpc["result"] as? [String: [String]], [
            "subscribed": ["network.changed"], "denied": ["app.didBecomeActive"]
        ])
        XCTAssertNil(host.networkEvent(.wifi, for: sid))

        _ = host.receive(echo(id: "unsubscribe", sid: sid, params: events, method: "bridge.unsubscribe@1"))
        var secondAcknowledgement: (() -> Void)?
        _ = host.receive(
            echo(id: "subscribe-again", sid: sid, params: events, method: "bridge.subscribe@1"),
            afterReply: { secondAcknowledgement = $0 }
        )
        try XCTUnwrap(firstAcknowledgement)()
        XCTAssertNil(host.networkEvent(.wifi, for: sid))
        try XCTUnwrap(secondAcknowledgement)()
        let event = try unpack(host.networkEvent(.wifi, for: sid))
        XCTAssertEqual(event.meta?["sid"] as? String, sid)
        XCTAssertEqual(event.rpc["method"] as? String, "bridge.event")
        XCTAssertNil(event.rpc["id"])
        let params = try XCTUnwrap(event.rpc["params"] as? [String: Any])
        XCTAssertEqual(params["name"] as? String, "network.changed")
        XCTAssertEqual(params["payload"] as? [String: String], ["type": "wifi"])
        XCTAssertNil(host.networkEvent(.wifi, for: "other-session"))

        host.reset()
        try XCTUnwrap(secondAcknowledgement)()
        XCTAssertNil(host.networkEvent(.wifi, for: sid))
        let newSID = try self.session(host)
        XCTAssertNil(host.networkEvent(.wifi, for: newSID))
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

final class NetworkConnectionTests: XCTestCase {
    func testOnlyOneRecognizedInterfaceResolvesToAnInterfaceName() {
        let cases: [(NWPath.Status, [NWInterface.InterfaceType], String)] = [
            (.satisfied, [.wifi], "wifi"),
            (.satisfied, [.cellular], "cellular"),
            (.satisfied, [.wiredEthernet], "ethernet"),
            (.satisfied, [.wifi, .cellular], "other"),
            (.satisfied, [.loopback], "other"),
            (.unsatisfied, [.wifi], "none"),
            (.requiresConnection, [.cellular], "none")
        ]
        for (status, interfaces, type) in cases {
            XCTAssertEqual(NetworkConnection(status: status, usesInterface: interfaces.contains).payload, ["type": type])
        }
    }
}
