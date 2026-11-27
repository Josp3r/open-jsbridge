import Foundation
import Network
import XCTest
@testable import NativeIOSHost

final class WireHostTests: XCTestCase {
    func testBusinessMethodCannotOverrideTheStandardUploadPolicy() {
        XCTAssertThrowsError(try NativeIOSHost.BusinessMethod("transfer.upload") { _ in NSNull() })
    }

    func testUploadRequiresMediaSupportAndAnUnambiguousEndpointGrant() throws {
        let page = URL(string: "https://app.example.test")!
        let url = URL(string: "https://images.example.test/avatar")!
        let endpoint = try NativeIOSHost.UploadEndpoint(origin: page, url: url)
        for host in [
            WireHost(platform: "ios", options: .init(uploadEndpoints: [endpoint])),
            WireHost(platform: "ios", options: .init(media: true, uploadEndpoints: [endpoint]), supportsMedia: false),
            WireHost(platform: "ios", options: .init(media: true, uploadEndpoints: [endpoint, endpoint]))
        ] {
            let reply = try unpack(host.receive(hello(id: "hello", wantsCallbacks: true), verifiedOrigin: page.absoluteString))
            let result = try XCTUnwrap(reply.rpc["result"] as? [String: Any])
            let caps = try XCTUnwrap(result["capabilities"] as? [String: Any])
            XCTAssertNil((caps["methods"] as? [String: Any])?["transfer.upload"])
            XCTAssertFalse((caps["features"] as? [String] ?? []).contains("callbacks"))
        }
    }

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

    func testCancelNotificationDispatchRequiresAnActiveSessionAndValidControlShape() throws {
        let host = WireHost(platform: "ios")
        var cancellations = [String]()
        let cancel: (String) -> Void = { cancellations.append($0) }
        func frame(sid: String, method: String = "bridge.cancel", params: String = #"{"requestId":"target"}"#,
                   extra: String = "") -> String {
            #"{"jsb":"1.0","meta":{"sid":"\#(sid)"},"rpc":{"jsonrpc":"2.0","method":"\#(method)","params":\#(params)\#(extra)}}"#
        }

        XCTAssertNil(host.receive(frame(sid: "fresh"), onCancelRequest: cancel))
        let sid = try session(host)
        let invalid = [
            frame(sid: "old"),
            frame(sid: sid, method: "bridge.cancel@2"),
            frame(sid: sid, params: #"{"requestId":""}"#),
            frame(sid: sid, params: #"{"requestId":"target","reason":null}"#),
            frame(sid: sid, extra: #","result":null"#)
        ]
        for raw in invalid {
            XCTAssertNil(host.receive(raw, onCancelRequest: cancel))
        }

        let request = try unpack(host.receive(frame(sid: sid, extra: #","id":"cancel-request""#),
                                             onCancelRequest: cancel))
        XCTAssertEqual(request.rpc["id"] as? String, "cancel-request")
        XCTAssertEqual(request.error?["code"] as? Int, -32600)
        XCTAssertEqual(cancellations, [])

        XCTAssertNil(host.receive(frame(sid: sid), exceedsInflightLimit: true, onCancelRequest: cancel))
        XCTAssertNil(host.receive(frame(sid: sid, method: "bridge.cancel@1",
                                       params: #"{"requestId":"second","reason":"abort"}"#),
                                  onCancelRequest: cancel))
        XCTAssertEqual(cancellations, ["target", "second"])
    }

    func testSubscriptionControlsDenyUnavailableEventsAndValidateNames() throws {
        let host = WireHost(platform: "ios")
        let sid = try session(host)
        let events = #"{"events":["network.statusChanged","app.didBecomeActive"]}"#
        let subscribe = try unpack(host.receive(echo(id: "subscribe", sid: sid, params: events, method: "bridge.subscribe@1")))
        XCTAssertEqual(subscribe.rpc["result"] as? [String: [String]], [
            "subscribed": [], "denied": ["network.statusChanged", "app.didBecomeActive"]
        ])
        let unsubscribe = try unpack(host.receive(echo(id: "unsubscribe", sid: sid, params: events, method: "bridge.unsubscribe")))
        XCTAssertEqual(unsubscribe.rpc["result"] as? [String: [String]], [
            "unsubscribed": ["network.statusChanged", "app.didBecomeActive"]
        ])

        for (index, invalid) in ["{}", #"{"events":[]}"#, #"{"events":["network.statusChanged","network.statusChanged"]}"#,
                                 #"{"events":["rpc.event"]}"#, #"{"events":["network.statusChanged@1"]}"#,
                                 #"{"events":["network.statusChanged\n"]}"#, #"{"events":["network.statusChanged",1]}"#].enumerated() {
            for method in ["bridge.subscribe", "bridge.unsubscribe"] {
                let result = try unpack(host.receive(echo(id: "\(method)-\(index)", sid: sid, params: invalid, method: method)))
                XCTAssertEqual(result.error?["code"] as? Int, -32602)
            }
        }
    }

    func testBusinessEventsRequireCurrentAcknowledgedSubscription() throws {
        let config = "acme.app.configChanged"
        let account = "acme.app.accountChanged"
        let unknown = "acme.app.unknown"
        let host = WireHost(platform: "ios", options: .init(networkChanges: true), businessEvents: [config, account])
        let result = try XCTUnwrap(unpack(host.receive(hello(id: "hello"))).rpc["result"] as? [String: Any])
        let sid = try XCTUnwrap(result["sid"] as? String)
        let capabilities = try XCTUnwrap(result["capabilities"] as? [String: Any])
        XCTAssertEqual(Set(capabilities["events"] as? [String] ?? []), [config, account, NetworkModule.event])

        let payload: [Any] = [true, "system", NSNull()]
        XCTAssertNil(host.businessEvent(config, payload: payload, for: sid))
        var acknowledgements = [() -> Void]()
        let params = #"{"events":["\#(config)","\#(account)","\#(unknown)","network.statusChanged"]}"#
        let subscribe = try unpack(host.receive(echo(id: "initial", sid: sid, params: params, method: "bridge.subscribe"),
                                                afterReply: { acknowledgements.append($0) }))
        XCTAssertEqual(subscribe.rpc["result"] as? [String: [String]], [
            "subscribed": [config, account, NetworkModule.event], "denied": [unknown]
        ])
        XCTAssertNil(host.businessEvent(config, payload: payload, for: sid))
        XCTAssertFalse(host.watchesNetwork)

        let configOnly = #"{"events":["\#(config)"]}"#
        _ = host.receive(echo(id: "off", sid: sid, params: configOnly, method: "bridge.unsubscribe"))
        _ = host.receive(echo(id: "again", sid: sid, params: configOnly, method: "bridge.subscribe"),
                         afterReply: { acknowledgements.append($0) })
        XCTAssertEqual(acknowledgements.count, 2)
        for callback in acknowledgements.prefix(1) { callback() }
        XCTAssertNil(host.businessEvent(config, payload: payload, for: sid))
        XCTAssertNotNil(host.businessEvent(account, payload: NSNull(), for: sid))
        XCTAssertTrue(host.watchesNetwork)
        XCTAssertNotNil(host.networkEvent(.wifi, for: sid))

        let newAck = try XCTUnwrap(acknowledgements.last)
        newAck()
        let event = try unpack(host.businessEvent(config, payload: payload, for: sid))
        XCTAssertEqual(event.meta?["sid"] as? String, sid)
        XCTAssertNil(event.rpc["id"])
        XCTAssertEqual(event.rpc["method"] as? String, "bridge.event")
        let eventParams = try XCTUnwrap(event.rpc["params"] as? [String: Any])
        XCTAssertEqual(eventParams["name"] as? String, config)
        XCTAssertEqual(eventParams["payload"] as? NSArray, payload as NSArray)
        XCTAssertNil(host.businessEvent(config, payload: payload, for: "old"))
        XCTAssertNil(host.businessEvent(unknown, payload: payload, for: sid))
        XCTAssertNil(host.businessEvent(NetworkModule.event, payload: payload, for: sid))
        for invalid: Any in [Date(), Double.nan, 9_007_199_254_740_992, String(repeating: "x", count: WireHost.maxMessageBytes)] {
            XCTAssertNil(host.businessEvent(config, payload: invalid, for: sid))
        }

        _ = host.receive(echo(id: "off-again", sid: sid, params: configOnly, method: "bridge.unsubscribe"))
        XCTAssertNil(host.businessEvent(config, payload: payload, for: sid))
        XCTAssertNotNil(host.businessEvent(account, payload: 42, for: sid))
        host.reset()
        let currentSID = try session(host)
        newAck()
        XCTAssertNotEqual(sid, currentSID)
        XCTAssertNil(host.businessEvent(account, payload: 42, for: sid))
        XCTAssertNil(host.businessEvent(account, payload: 42, for: currentSID))
        XCTAssertFalse(host.watchesNetwork)
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
        let controls = try unpack(network.receive(echo(id: "events", sid: networkSID, params: #"{"events":["network.statusChanged"]}"#, method: "bridge.subscribe")))
        XCTAssertEqual(controls.rpc["result"] as? [String: [String]], ["subscribed": [], "denied": ["network.statusChanged"]])
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

    func testToastIsAdvertisedOnlyWhenEnabledAndUnknownVersionsStayUnavailable() throws {
        let disabled = WireHost(platform: "ios", enableEcho: false)
        let disabledHello = try XCTUnwrap(unpack(disabled.receive(hello(id: "off"))).rpc["result"] as? [String: Any])
        let disabledSID = try XCTUnwrap(disabledHello["sid"] as? String)
        let disabledCapabilities = try XCTUnwrap(disabledHello["capabilities"] as? [String: Any])
        XCTAssertEqual(disabledCapabilities["methods"] as? [String: [String: [Int]]], [:])
        let params = #"{"text":"Hello"}"#
        for (index, method) in ["ui.toast.show", "ui.toast.show@1"].enumerated() {
            let reply = try unpack(disabled.receive(echo(id: "off-\(index)", sid: disabledSID,
                                                         params: params, method: method)))
            XCTAssertEqual(reply.error?["code"] as? Int, -32601)
        }

        let enabled = WireHost(platform: "ios", options: .init(toast: true), enableEcho: false)
        let enabledHello = try XCTUnwrap(unpack(enabled.receive(hello(id: "on"))).rpc["result"] as? [String: Any])
        let enabledSID = try XCTUnwrap(enabledHello["sid"] as? String)
        let enabledCapabilities = try XCTUnwrap(enabledHello["capabilities"] as? [String: Any])
        XCTAssertEqual(enabledCapabilities["methods"] as? [String: [String: [Int]]], [
            "ui.toast.show": ["versions": [1]]
        ])
        for (index, method) in ["ui.toast.show@2", "ui.toast.cancel"].enumerated() {
            let reply = try unpack(enabled.receive(echo(id: "unknown-\(index)", sid: enabledSID,
                                                        params: params, method: method)))
            XCTAssertEqual(reply.error?["code"] as? Int, -32601)
        }
        XCTAssertThrowsError(try NativeIOSHost.BusinessMethod("ui.toast.show") { _ in NSNull() })
    }

    func testToastValidatesCodePointBoundsAndOnlyAcceptsText() throws {
        let host = WireHost(platform: "ios", options: .init(toast: true))
        let sid = try session(host)
        let composed60 = String(repeating: "e\u{0301}", count: 60)
        let emoji120 = String(repeating: "🦉", count: 120)
        let accepted = [("ui.toast.show", "x"), ("ui.toast.show@1", composed60), ("ui.toast.show", emoji120)]
        var presented: [String] = []
        func present(_ text: String) -> Bool {
            presented.append(text)
            return true
        }
        for (index, (method, text)) in accepted.enumerated() {
            let request = echo(id: "accepted-\(index)", sid: sid, params: #"{"text":"\#(text)"}"#, method: method)
            let result = try unpack(host.receive(request, presentToast: present))
            XCTAssertEqual(result.rpc["result"] as? [String: String], [:])
        }

        let overLimit = composed60 + "e"
        let invalid = ["{}", #"{"text":""}"#, #"{"text":42}"#, #"{"text":null}"#,
                       #"{"text":"a","extra":true}"#, #"{"text":"\#(overLimit)"}"#]
        for (index, params) in invalid.enumerated() {
            let request = echo(id: "invalid-\(index)", sid: sid, params: params, method: "ui.toast.show")
            XCTAssertEqual(try unpack(host.receive(request, presentToast: present)).error?["code"] as? Int, -32602)
        }
        let missingParams = #"{"jsb":"1.0","meta":{"sid":"\#(sid)"},"rpc":{"jsonrpc":"2.0","id":"missing","method":"ui.toast.show"}}"#
        XCTAssertEqual(try unpack(host.receive(missingParams, presentToast: present)).error?["code"] as? Int, -32602)
        XCTAssertEqual(presented, accepted.map { $0.1 })
    }

    func testToastReturnsInternalErrorWhenPresenterIsUnavailable() throws {
        let host = WireHost(platform: "ios", options: .init(toast: true))
        let sid = try session(host)
        let request = echo(id: "unavailable", sid: sid, params: #"{"text":"Hello"}"#, method: "ui.toast.show")
        XCTAssertEqual(try unpack(host.receive(request)).error?["code"] as? Int, -32603)
    }

    @MainActor
    func testMediaOptInAdvertisesSelectionAndReleaseAndRejectsRetiredBlobMethods() throws {
        let disabled = WireHost(platform: "ios", enableEcho: false)
        let disabledSID = try session(disabled)
        let methods = ["media.chooseMedia", "media.release@1", "bridge.blob.read", "bridge.blob.release"]
        for method in methods {
            XCTAssertEqual(try unpack(disabled.receive(echo(id: method, sid: disabledSID, method: method)))
                .error?["code"] as? Int, -32601)
        }

        let host = WireHost(platform: "ios", options: .init(media: true), enableEcho: false)
        let result = try XCTUnwrap(unpack(host.receive(hello(id: "enabled"))).rpc["result"] as? [String: Any])
        let sid = try XCTUnwrap(result["sid"] as? String)
        let capabilities = try XCTUnwrap(result["capabilities"] as? [String: Any])
        XCTAssertEqual(capabilities["methods"] as? [String: [String: [Int]]], [
            "media.chooseMedia": ["versions": [1]], "media.release": ["versions": [1]]
        ])
        XCTAssertEqual(Set(capabilities["features"] as? [String] ?? []), ["cancel"])
        for (index, method) in ["bridge.blob.read", "bridge.blob.read@1", "bridge.blob.release", "bridge.blob.release@1"].enumerated() {
            let request = echo(id: "retired-\(index)", sid: sid, method: method)
            XCTAssertEqual(try unpack(host.receive(request)).error?["code"] as? Int, -32601)
        }
        let invalid = [#"{"mediaType":["video"]}"#, #"{"mediaType":"image"}"#, #"{"sourceType":["camera"]}"#,
                       #"{"count":2}"#, #"{"count":true}"#, #"{"count":null}"#, #"{"other":1}"#]
        for (index, params) in invalid.enumerated() {
            let reply = try unpack(host.receive(echo(id: "invalid-\(index)", sid: sid, params: params,
                                                    method: "media.chooseMedia@1")))
            XCTAssertEqual(reply.error?["code"] as? Int, -32602)
        }
        let busy = echo(id: "busy", sid: sid, method: "media.chooseMedia")
        XCTAssertEqual(try unpack(host.receive(busy, mediaBusy: true)).error?["code"] as? Int, -32010)
        XCTAssertThrowsError(try NativeIOSHost.BusinessMethod("media.chooseMedia") { _ in NSNull() })
        XCTAssertThrowsError(try NativeIOSHost.BusinessMethod("bridge.blob.read") { _ in NSNull() })
    }

    @MainActor
    func testMediaSelectionReturnsOriginalMetadataAndOnlyTheThumbnailBytes() async throws {
        let host = WireHost(platform: "ios", options: .init(media: true))
        let sid = try session(host)
        let raw = try makeMediaJPEG(width: 800, height: 640, orientation: 6)
        let image = try MediaImage.prepare(data: raw, mime: "image/jpeg")
        let result = try await completeMedia(.selected(image), id: "pick", sid: sid, in: host)
        XCTAssertEqual(result["status"] as? String, "selected")
        let files = try XCTUnwrap(result["files"] as? [[String: Any]])
        XCTAssertEqual(files.count, 1)
        let file = try XCTUnwrap(files.first)
        XCTAssertEqual(Set(file.keys), ["type", "id", "mime", "size", "width", "height", "expiresAt", "thumbnailBase64"])
        let id = try XCTUnwrap(file["id"] as? String)
        XCTAssertNotNil(id.range(of: #"\A[0-9a-f]{32}\z"#, options: .regularExpression))
        XCTAssertEqual(file["type"] as? String, "image")
        XCTAssertEqual(file["mime"] as? String, "image/jpeg")
        XCTAssertEqual(file["size"] as? Int, raw.count)
        XCTAssertEqual(file["width"] as? Int, 640)
        XCTAssertEqual(file["height"] as? Int, 800)
        let ttl = try XCTUnwrap(file["expiresAt"] as? Int64) - Int64(Date().timeIntervalSince1970 * 1000)
        XCTAssertTrue((295_000...300_000).contains(ttl))
        let encoded = try XCTUnwrap(file["thumbnailBase64"] as? String)
        let thumbnail = try XCTUnwrap(Data(base64Encoded: encoded))
        XCTAssertEqual(thumbnail, image.thumbnail)
        XCTAssertNotEqual(thumbnail, raw)
    }

    @MainActor
    func testMediaPickerDismissalReturnsAnEmptySelection() async throws {
        let host = WireHost(platform: "ios", options: .init(media: true))
        let sid = try session(host)
        let result = try await completeMedia(.cancelled, id: "pick", sid: sid, in: host)
        XCTAssertEqual(result["status"] as? String, "cancelled")
        XCTAssertEqual((result["files"] as? [Any])?.count, 0)
    }

    @MainActor
    func testUploadAdmissionBindsOriginHandleAndTerminalToTheOriginalCall() async throws {
        let origin = URL(string: "https://app.example.test")!
        let url = URL(string: "https://api.example.test/avatar")!
        let endpoint = try NativeIOSHost.UploadEndpoint(origin: origin, url: url)
        let host = WireHost(platform: "ios", options: .init(media: true, uploadEndpoints: [endpoint]))
        func handshake(_ origin: String) throws -> [String: Any] {
            let reply = try unpack(host.receive(hello(id: "hello", wantsCallbacks: true), verifiedOrigin: origin))
            return try XCTUnwrap(reply.rpc["result"] as? [String: Any])
        }
        let denied = try handshake("https://app.example.test:8443")
        let capabilities = try XCTUnwrap(denied["capabilities"] as? [String: Any])
        XCTAssertNil((capabilities["methods"] as? NSDictionary)?["transfer.upload"])
        XCTAssertFalse((capabilities["features"] as? [String] ?? []).contains("callbacks"))
        host.reset()
        let allowed = try handshake(origin.absoluteString)
        let advertised = try XCTUnwrap(allowed["capabilities"] as? [String: Any])
        XCTAssertEqual((advertised["methods"] as? [String: [String: [Int]]])?["transfer.upload"], ["versions": [1]])
        XCTAssertEqual(Set(advertised["features"] as? [String] ?? []), ["callbacks", "cancel"])
        let sid = try XCTUnwrap(allowed["sid"] as? String)
        let pick = try await completeMedia(mediaSelection(bytes: 4096), id: "pick", sid: sid, in: host)
        let handle = try XCTUnwrap((pick["files"] as? [[String: Any]])?.first?["id"] as? String)
        let params = #"{"id":"\#(handle)","request":{"url":"https://api.example.test/avatar"}}"#
        func upload(_ id: String) -> String { echo(id: id, sid: sid, params: params, method: "transfer.upload@1") }
        func unexpected(_ call: WireHost.BusinessCall) { XCTFail("Unexpected upload dispatch") }
        XCTAssertEqual(try unpack(host.receive(upload("background"), isForeground: { false },
                                               onBusinessCall: unexpected)).error?["code"] as? Int, -32003)
        XCTAssertEqual(try unpack(host.receive(upload("expired"), receivedAt: .now() - .seconds(16),
                                               isForeground: { true }, onBusinessCall: unexpected)).error?["code"] as? Int, -32001)
        var call: WireHost.BusinessCall?
        XCTAssertNil(host.receive(upload("one"), isForeground: { true }, onBusinessCall: { call = $0 }))
        let pending = try XCTUnwrap(call)
        XCTAssertNil(host.receive(upload("one"), isForeground: { true }, onBusinessCall: unexpected))
        XCTAssertEqual(try unpack(host.receive(upload("busy"), isForeground: { true },
                                               onBusinessCall: unexpected)).error?["code"] as? Int, -32010)
        let release = echo(id: "release", sid: sid, params: #"{"ids":["\#(handle)"]}"#, method: "media.release")
        XCTAssertTrue(try unpack(host.receive(release)).rpc["result"] is NSNull)
        let terminal = try unpack(host.cancelBusinessCall(pending))
        XCTAssertEqual(terminal.rpc["id"] as? String, "one")
        XCTAssertEqual(terminal.error?["code"] as? Int, -32003)
        XCTAssertEqual(try unpack(host.receive(upload("released"), isForeground: { true },
                                               onBusinessCall: unexpected)).error?["code"] as? Int, -32003)
    }

    @MainActor
    func testUploadStopsOnBackgroundAndDocumentResetWithoutEventSubscriptions() async throws {
        let origin = URL(string: "https://app.example.test")!
        let endpoint = try NativeIOSHost.UploadEndpoint(origin: origin, url: URL(string: "https://cdn.example.test/avatar")!)
        let host = WireHost(platform: "ios", options: .init(media: true, uploadEndpoints: [endpoint]))
        _ = host.receive(hello(id: "hello"), verifiedOrigin: origin.absoluteString)
        let sid = try XCTUnwrap(host.sid)
        XCTAssertFalse(host.watchesAppLifecycle)
        XCTAssertTrue(host.hasUploadEndpoints)
        let pick = try await completeMedia(mediaSelection(bytes: 4096), id: "pick", sid: sid, in: host)
        let handle = try XCTUnwrap((pick["files"] as? [[String: Any]])?.first?["id"] as? String)
        let params = #"{"id":"\#(handle)","request":{"url":"https://cdn.example.test/avatar"}}"#
        func admitted(_ id: String) throws -> WireHost.BusinessCall {
            var pending: WireHost.BusinessCall?
            XCTAssertNil(host.receive(echo(id: id, sid: sid, params: params, method: "transfer.upload"),
                                      isForeground: { true }, onBusinessCall: { pending = $0 }))
            return try XCTUnwrap(pending)
        }
        let first = try admitted("first")
        host.cancelUploadForBackground()
        let retry = try admitted("retry")
        let error = try unpack(host.finishBusinessCall(first, result: .success(["status": 201, "body": "late"]))).error
        XCTAssertEqual(error?["code"] as? Int, -32002)
        XCTAssertEqual((error?["data"] as? [String: String])?["reason"], "backgrounded")
        host.reset()
        XCTAssertFalse(host.hasUploadEndpoints)
        _ = host.receive(hello(id: "new-hello"), verifiedOrigin: origin.absoluteString)
        XCTAssertNil(host.finishBusinessCall(retry, result: .success(["status": 201, "body": "late"])))
        let foreign = echo(id: "foreign", sid: try XCTUnwrap(host.sid), params: params, method: "transfer.upload")
        let denied = host.receive(foreign, isForeground: { true }, onBusinessCall: { _ in XCTFail("Stale handle dispatched") })
        XCTAssertEqual(try unpack(denied).error?["code"] as? Int, -32003)
    }

    @MainActor
    func testMediaReleaseValidatesTheWholeBatchBeforeReclaimingQuota() async throws {
        let host = WireHost(platform: "ios", options: .init(media: true))
        let sid = try session(host)
        let half = try mediaSelection(bytes: 10 * 1024 * 1024)
        let first = try await completeMedia(half, id: "first", sid: sid, in: host)
        let second = try await completeMedia(half, id: "second", sid: sid, in: host)
        let handle = try XCTUnwrap((first["files"] as? [[String: Any]])?.first?["id"] as? String)
        let other = try XCTUnwrap((second["files"] as? [[String: Any]])?.first?["id"] as? String)
        let quoted = "\"\(handle)\""
        let maximumBatch = (Array(repeating: quoted, count: 31) + ["\"\(other)\""]).joined(separator: ",")
        let invalid = [
            "{}", #"{"ids":[]}"#, #"{"ids":null}"#, #"{"ids":\#(quoted)}"#,
            #"{"ids":[\#(quoted)],"extra":true}"#, #"{"ids":[\#(maximumBatch),\#(quoted)]}"#,
            #"{"ids":[\#(quoted),1]}"#, #"{"ids":[\#(quoted),"\#(handle.dropLast())"]}"#,
            #"{"ids":["\#(handle)0"]}"#, #"{"ids":["A\#(handle.dropFirst())"]}"#, #"{"ids":["\#(handle)\n"]}"#
        ]
        for (index, params) in invalid.enumerated() {
            let request = echo(id: "invalid-\(index)", sid: sid, params: params, method: "media.release@1")
            XCTAssertEqual(try unpack(host.receive(request)).error?["code"] as? Int, -32602, params)
        }
        let blocked = try await mediaRPC(half, id: "still-full", sid: sid, in: host)
        XCTAssertEqual((blocked["error"] as? [String: Any])?["code"] as? Int, -32006)

        let release = echo(id: "release", sid: sid, params: #"{"ids":[\#(maximumBatch)]}"#, method: "media.release@1")
        XCTAssertTrue(try unpack(host.receive(release)).rpc["result"] is NSNull)
        _ = try await completeMedia(half, id: "refill-first", sid: sid, in: host)
        _ = try await completeMedia(half, id: "refill-second", sid: sid, in: host)
    }

    @MainActor
    func testMediaReleaseIsScopedToItsSessionAndRetryOnlyFreesTheListedHandlesOnce() async throws {
        let host = WireHost(platform: "ios", options: .init(media: true))
        let oldSID = try session(host)
        host.reset()
        let sid = try session(host)
        let other = WireHost(platform: "ios", options: .init(media: true))
        let otherSID = try session(other)
        let half = try mediaSelection(bytes: 10 * 1024 * 1024)
        let first = try await completeMedia(half, id: "first", sid: sid, in: host)
        let handle = try XCTUnwrap((first["files"] as? [[String: Any]])?.first?["id"] as? String)
        _ = try await completeMedia(half, id: "second", sid: sid, in: host)
        let params = #"{"ids":["\#(handle)"]}"#

        XCTAssertNil(host.receive(echo(id: "stale", sid: oldSID, params: params, method: "media.release@1")))
        let foreign = echo(id: "foreign", sid: otherSID, params: params, method: "media.release@1")
        XCTAssertTrue(try unpack(other.receive(foreign)).rpc["result"] is NSNull)
        let stillFull = try await mediaRPC(half, id: "still-full", sid: sid, in: host)
        XCTAssertEqual((stillFull["error"] as? [String: Any])?["code"] as? Int, -32006)

        for id in ["release", "retry"] {
            let request = echo(id: id, sid: sid, params: params, method: "media.release@1")
            XCTAssertTrue(try unpack(host.receive(request)).rpc["result"] is NSNull)
        }
        _ = try await completeMedia(half, id: "replacement", sid: sid, in: host)
        let overQuota = try await mediaRPC(half, id: "over-quota", sid: sid, in: host)
        XCTAssertEqual((overQuota["error"] as? [String: Any])?["code"] as? Int, -32006)
    }

    private func mediaSelection(bytes: Int) throws -> MediaSelection {
        let jpeg = try makeMediaJPEG(width: 8, height: 8)
        let padded = jpeg + Data(repeating: 0, count: bytes - jpeg.count)
        return .selected(MediaImage(data: padded, mime: "image/jpeg", width: 8, height: 8, thumbnail: jpeg))
    }

    @MainActor
    func testMediaUnavailableWhenPickerOrDispatchIsMissing() throws {
        let host = WireHost(platform: "ios", options: .init(media: true))
        let sid = try session(host)
        let missing = echo(id: "missing", sid: sid, method: "media.chooseMedia")
        XCTAssertEqual(try unpack(host.receive(missing)).error?["code"] as? Int, -32003)

        let cannotDispatch = echo(id: "dispatcher", sid: sid, method: "media.chooseMedia")
        let reply = host.receive(cannotDispatch, chooseMedia: { _ in MediaSelection.cancelled })
        XCTAssertEqual(try unpack(reply).error?["code"] as? Int, -32003)
    }

    @MainActor
    func testMediaErrorsKeepSystemFailureBusyQuotaAndAbortDistinct() async throws {
        let host = WireHost(platform: "ios", options: .init(media: true))
        let sid = try session(host)
        let cases: [(Int, NativeIOSHost.BusinessMethod.Handler)] = [
            (-32003, { _ in throw MediaProfileError.unavailable }),
            (-32003, { _ in throw CocoaError(.fileReadNoSuchFile) }),
            (-32003, { _ in try MediaImage.prepare(data: Data([1, 2, 3]), mime: "image/png") }),
            (-32010, { _ in throw MediaProfileError.busy }),
            (-32006, { _ in throw MediaProfileError.tooLarge }),
            (-32002, { _ in throw CancellationError() })
        ]
        for (i, item) in cases.enumerated() {
            let (code, handle) = item
            let request = echo(id: "failure-\(i)", sid: sid, method: "media.chooseMedia@1")
            var call: WireHost.BusinessCall?
            XCTAssertNil(host.receive(request, chooseMedia: handle, onBusinessCall: { call = $0 }))
            let pending = try XCTUnwrap(call)
            let failure: Error
            do {
                _ = try await pending.run()
                XCTFail("Expected handler failure")
                continue
            } catch {
                failure = error
            }
            let reply = try unpack(host.finishBusinessCall(pending, result: .failure(failure)))
            XCTAssertEqual(reply.error?["code"] as? Int, code)
            XCTAssertNil(reply.rpc["result"])
            if code == -32002 {
                XCTAssertEqual(try unpack(host.cancelBusinessCall(pending)).error?["code"] as? Int, code)
            }
        }
    }

    @MainActor
    func testMediaStoreEnforcesTheTotalQuotaAndResetFreesCapacity() throws {
        let store = MediaStore()
        let second = try MediaImage.prepare(data: makeMediaJPEG(width: 8, height: 8), mime: "image/jpeg")
        let first = MediaImage(data: Data(repeating: 1, count: 20 * 1024 * 1024), mime: second.mime,
                               width: second.width, height: second.height, thumbnail: second.thumbnail)
        let descriptor = try store.insert(first)
        XCTAssertEqual(descriptor["size"] as? Int, 20 * 1024 * 1024)
        XCTAssertThrowsError(try store.insert(second)) { error in
            guard case MediaProfileError.tooLarge = error else { return XCTFail("Unexpected error: \(error)") }
        }
        store.reset()
        XCTAssertEqual(try store.insert(second)["size"] as? Int, second.data.count)
    }

    @MainActor
    func testLateMediaSelectionCannotCreateAResourceAfterDocumentReset() async throws {
        let host = WireHost(platform: "ios", options: .init(media: true))
        let sid = try session(host)
        let omitted = #"{"jsb":"1.0","meta":{"sid":"\#(sid)"},"rpc":{"jsonrpc":"2.0","id":"pick","method":"media.chooseMedia"}}"#
        let image = try MediaImage.prepare(data: makeMediaJPEG(width: 8, height: 8), mime: "image/jpeg")
        var pendingCall: WireHost.BusinessCall?
        XCTAssertNil(host.receive(omitted, chooseMedia: { _ in MediaSelection.selected(image) },
                                  onBusinessCall: { pendingCall = $0 }))
        let call = try XCTUnwrap(pendingCall)
        host.reset()
        XCTAssertNotEqual(try session(host), sid)
        let value = try await call.run()
        XCTAssertNil(host.finishBusinessCall(call, result: .success(value)))
    }

    @MainActor
    private func completeMedia(_ selection: MediaSelection, id: String, sid: String, in host: WireHost) async throws -> [String: Any] {
        let rpc = try await mediaRPC(selection, id: id, sid: sid, in: host)
        return try XCTUnwrap(rpc["result"] as? [String: Any])
    }

    @MainActor
    private func mediaRPC(_ selection: MediaSelection, id: String, sid: String, in host: WireHost) async throws -> [String: Any] {
        var call: WireHost.BusinessCall?
        let request = echo(id: id, sid: sid, params: #"{"mediaType":["image"],"sourceType":["album"],"count":1}"#,
                           method: "media.chooseMedia@1")
        XCTAssertNil(host.receive(request, chooseMedia: { _ in selection }, onBusinessCall: { call = $0 }))
        let pending = try XCTUnwrap(call)
        let value = try await pending.run()
        return try unpack(host.finishBusinessCall(pending, result: .success(value))).rpc
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
                            businessMethods: [name: try .init(name) { _ in NSNull() }], enableEcho: false)
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

    @MainActor
    func testProgressHandshakeKeepsCapabilitiesFromFirstSuccessfulHello() async throws {
        let host = try streamingHost()
        func features(_ host: WireHost, _ id: String, wantsCallbacks: Bool) throws -> Set<String> {
            let request = hello(id: id, wantsCallbacks: wantsCallbacks)
            let reply = try XCTUnwrap(unpack(host.receive(request)).rpc["result"] as? [String: Any])
            let capabilities = try XCTUnwrap(reply["capabilities"] as? [String: Any])
            return Set(try XCTUnwrap(capabilities["features"] as? [String]))
        }
        let ordinary = try NativeIOSHost.BusinessMethod("acme.jobs.plain") { _ in NSNull() }
        let plainHost = WireHost(platform: "ios", businessMethods: [ordinary.name: ordinary])
        XCTAssertEqual(try features(plainHost, "plain", wantsCallbacks: true), ["cancel"])
        XCTAssertEqual(try features(host, "first", wantsCallbacks: true), ["callbacks", "cancel"])
        XCTAssertEqual(try features(host, "repeat", wantsCallbacks: false), ["callbacks", "cancel"])
        host.reset()
        let unsupported = hello(id: "unsupported", protocols: "[2]", wantsCallbacks: true)
        XCTAssertEqual(try unpack(host.receive(unsupported)).error?["code"] as? Int, -32004)
        XCTAssertEqual(try features(host, "first", wantsCallbacks: false), ["cancel"])
        XCTAssertEqual(try features(host, "repeat", wantsCallbacks: true), ["cancel"])
        let call = try startBusinessCall(in: host, id: "no-callbacks")
        await assertNoProgress(from: host, for: call, chunk: "idle")
        XCTAssertEqual(try unpack(host.finishBusinessCall(call, result: .success("done"))).rpc["result"] as? String, "done")
    }

    @MainActor
    func testProgressFramesAreCorrelatedOrderedAndWithinTheByteLimit() async throws {
        let host = try streamingHost()
        _ = try session(host, wantsCallbacks: true)
        let first = try startBusinessCall(in: host, id: "first")
        let second = try startBusinessCall(in: host, id: "second")
        let ordinary = try startBusinessCall(in: host, id: "ordinary", method: "acme.jobs.plain")
        await assertNoProgress(from: host, for: ordinary, chunk: "unregistered")
        try await assertProgress(from: host, for: first, chunk: nil, expected: ["requestId": "first", "seq": 0])
        try await assertProgress(from: host, for: second, chunk: NSNull(),
                                 expected: ["requestId": "second", "seq": 0, "chunk": NSNull()])
        let oversized = String(repeating: "界", count: WireHost.maxMessageBytes / 3)
        for invalid: Any in [Date(), ["fraction": Double.nan], [9_007_199_254_740_992 as Int64], oversized] {
            await assertNoProgress(from: host, for: first, chunk: invalid)
        }
        var declined: String?
        let sent = await host.sendProgress(for: first, chunk: "declined") { declined = $0; return false }
        XCTAssertFalse(sent)
        XCTAssertEqual((try unpack(declined).rpc["params"] as? [String: Any])?["seq"] as? Int, 1)
        let payload = ["sent": 3, "total": 10]
        try await assertProgress(from: host, for: first, chunk: payload,
                                 expected: ["requestId": "first", "seq": 1, "chunk": payload])
        XCTAssertTrue(try unpack(host.finishBusinessCall(first, result: .success(NSNull()))).rpc["result"] is NSNull)
        await assertNoProgress(from: host, for: first, chunk: "late")
        try await assertProgress(from: host, for: second, chunk: "more",
                                 expected: ["requestId": "second", "seq": 1, "chunk": "more"])
        XCTAssertEqual(try unpack(host.cancelBusinessCall(second)).error?["code"] as? Int, -32002)
        await assertNoProgress(from: host, for: second, chunk: "cancelled")
    }

    @MainActor
    func testProgressFromOldDocumentCannotUseAReissuedRequestID() async throws {
        let host = try streamingHost()
        let oldSID = try session(host, wantsCallbacks: true)
        let oldCall = try startBusinessCall(in: host, id: "same-id")
        host.reset()
        let newSID = try session(host, wantsCallbacks: true)
        XCTAssertNotEqual(oldSID, newSID)
        let newCall = try startBusinessCall(in: host, id: "same-id")
        await assertNoProgress(from: host, for: oldCall, chunk: "late")
        try await assertProgress(from: host, for: newCall, chunk: "current",
                                 expected: ["requestId": "same-id", "seq": 0, "chunk": "current"])
    }

    @MainActor
    func testProgressReporterDrainsAnOutstandingSendBeforeFinishing() async throws {
        let sending = expectation(description: "first delivery started")
        var receipt: CheckedContinuation<Bool, Never>?
        var deliveries = 0
        let progress = NativeIOSHost.ProgressReporter { _ in
            deliveries += 1
            guard deliveries == 1 else { return true }
            return await withCheckedContinuation {
                receipt = $0
                sending.fulfill()
            }
        }
        let first = Task { await progress.send("first") }
        await fulfillment(of: [sending], timeout: 2)
        var finished = false
        progress.whenDrained { finished = true }
        let overlap = await progress.send("overlap")
        XCTAssertFalse(overlap)
        XCTAssertEqual(deliveries, 1)
        XCTAssertFalse(finished)
        try XCTUnwrap(receipt).resume(returning: true)
        let sent = await first.value
        XCTAssertTrue(sent)
        XCTAssertTrue(finished)
    }

    private func streamingHost() throws -> WireHost {
        let stream = try NativeIOSHost.BusinessMethod("acme.jobs.stream", streaming: { _, _ in NSNull() })
        let plain = try NativeIOSHost.BusinessMethod("acme.jobs.plain") { _ in NSNull() }
        return WireHost(platform: "ios", businessMethods: [stream.name: stream, plain.name: plain])
    }

    private func startBusinessCall(in host: WireHost, id: String, method: String = "acme.jobs.stream@1") throws -> WireHost.BusinessCall {
        let request = echo(id: id, sid: try XCTUnwrap(host.sid), method: method)
        var call: WireHost.BusinessCall?
        XCTAssertNil(host.receive(request, onBusinessCall: { call = $0 }))
        return try XCTUnwrap(call)
    }

    @MainActor
    private func assertNoProgress(from host: WireHost, for call: WireHost.BusinessCall, chunk: Any,
                                  file: StaticString = #filePath, line: UInt = #line) async {
        let sent = await host.sendProgress(for: call, chunk: chunk) { _ in
            XCTFail("Unexpected progress delivery", file: file, line: line)
            return true
        }
        XCTAssertFalse(sent, file: file, line: line)
    }

    @MainActor
    private func assertProgress(from host: WireHost, for call: WireHost.BusinessCall, chunk: Any?, expected: NSDictionary,
                                file: StaticString = #filePath, line: UInt = #line) async throws {
        var raw: String?
        let sent = await host.sendProgress(for: call, chunk: chunk) { raw = $0; return true }
        XCTAssertTrue(sent, file: file, line: line)
        let frame = try unpack(raw)
        XCTAssertEqual(frame.meta?["sid"] as? String, host.sid, file: file, line: line)
        XCTAssertEqual(frame.rpc["method"] as? String, "bridge.progress", file: file, line: line)
        XCTAssertNil(frame.rpc["id"], file: file, line: line)
        XCTAssertEqual(frame.rpc["params"] as? NSDictionary, expected, file: file, line: line)
    }

    func testHelloKeepsOversizedCapabilityAdvertisementWithinTheWireLimit() throws {
        let name = "acme." + String(repeating: "a", count: WireHost.maxMessageBytes)
        let host = WireHost(platform: "ios", businessMethods: [name: try .init(name) { _ in NSNull() }], enableEcho: false)
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
        let host = WireHost(platform: "ios", businessMethods: [method.name: method])
        let sid = try session(host)
        let requests = [
            #"{"jsb":"1.0","meta":{"sid":"\#(sid)","traceId":"trace"},"rpc":{"jsonrpc":"2.0","id":"base","method":"acme.app.getConfig"}}"#,
            echo(id: "v1", sid: sid, params: #"{"locale":"中文"}"#, method: "acme.app.getConfig@1")
        ]
        for (index, request) in requests.enumerated() {
            var call: WireHost.BusinessCall?
            XCTAssertNil(host.receive(request, onBusinessCall: { call = $0 }))
            let deferred = try XCTUnwrap(call)
            let result = try await deferred.run()
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
        let host = WireHost(platform: "ios", businessMethods: [method: try .init(method) { _ in NSNull() }])
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
        let host = WireHost(platform: "ios", businessMethods: [method: try .init(method) { _ in NSNull() }])
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
        let host = WireHost(platform: "ios", businessMethods: [method: try .init(method) { _ in NSNull() }])
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
        XCTAssertEqual(capabilities["events"] as? [String], ["network.statusChanged"])
        XCTAssertEqual(capabilities["features"] as? [String], [])
        XCTAssertEqual(try unpack(host.receive(echo(id: "status-disabled", sid: sid, method: "network.getStatus"))).error?["code"] as? Int, -32601)
        XCTAssertNil(host.networkEvent(.wifi, for: sid))

        let events = #"{"events":["network.statusChanged","app.didBecomeActive"]}"#
        var firstAcknowledgement: (() -> Void)?
        let subscription = try unpack(host.receive(
            echo(id: "subscribe", sid: sid, params: events, method: "bridge.subscribe"),
            afterReply: { firstAcknowledgement = $0 }
        ))
        XCTAssertEqual(subscription.rpc["result"] as? [String: [String]], [
            "subscribed": ["network.statusChanged"], "denied": ["app.didBecomeActive"]
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
        XCTAssertEqual(params["name"] as? String, "network.statusChanged")
        XCTAssertEqual(params["payload"] as? [String: String], ["type": "wifi"])
        XCTAssertNil(host.networkEvent(.wifi, for: "other-session"))

        host.reset()
        try XCTUnwrap(secondAcknowledgement)()
        XCTAssertNil(host.networkEvent(.wifi, for: sid))
        let newSID = try self.session(host)
        XCTAssertNil(host.networkEvent(.wifi, for: newSID))
    }

    func testOldNetworkEventIsUnavailableAlongsideTheCanonicalEvent() throws {
        let host = WireHost(platform: "ios", options: .init(networkChanges: true))
        let hello = try XCTUnwrap(unpack(host.receive(hello(id: "hello"))).rpc["result"] as? [String: Any])
        let sid = try XCTUnwrap(hello["sid"] as? String)
        let capabilities = try XCTUnwrap(hello["capabilities"] as? [String: Any])
        XCTAssertEqual(capabilities["events"] as? [String], ["network.statusChanged"])
        let subscribe = echo(id: "sub", sid: sid, params: #"{"events":["network.changed","network.statusChanged"]}"#,
                             method: "bridge.subscribe")
        let reply = try unpack(host.receive(subscribe))
        XCTAssertEqual(reply.rpc["result"] as? [String: [String]], [
            "subscribed": ["network.statusChanged"], "denied": ["network.changed"]
        ])
        XCTAssertNil(host.businessEvent("network.changed", payload: ["type": "wifi"], for: sid))
        let notification = try unpack(host.networkEvent(.wifi, for: sid))
        let payload = try XCTUnwrap(notification.rpc["params"] as? [String: Any])
        XCTAssertEqual(payload["name"] as? String, "network.statusChanged")
        XCTAssertEqual(payload["payload"] as? [String: String], ["type": "wifi"])
    }

    func testAppLifecycleIsOptInAndOnlyDeliversAcknowledgedEventWithNullPayload() throws {
        let names = ["app.foregrounded", "app.backgrounded"]
        let disabled = WireHost(platform: "ios")
        let disabledSID = try session(disabled)
        let params = #"{"events":["app.foregrounded"]}"#
        let unavailable = try unpack(disabled.receive(echo(id: "sub", sid: disabledSID, params: params,
                                                            method: "bridge.subscribe")))
        XCTAssertEqual(unavailable.rpc["result"] as? [String: [String]], [
            "subscribed": [], "denied": ["app.foregrounded"]
        ])
        XCTAssertFalse(disabled.watchesAppLifecycle)

        let host = WireHost(platform: "ios", options: .init(appLifecycle: true))
        let hello = try XCTUnwrap(unpack(host.receive(hello(id: "hello"))).rpc["result"] as? [String: Any])
        let sid = try XCTUnwrap(hello["sid"] as? String)
        let capabilities = try XCTUnwrap(hello["capabilities"] as? [String: Any])
        XCTAssertEqual(capabilities["events"] as? [String], names)
        XCTAssertFalse(host.watchesAppLifecycle)
        XCTAssertNil(host.appLifecycleEvent(.foregrounded, for: sid))
        var acknowledge: (() -> Void)?
        let request = echo(id: "sub", sid: sid, params: params, method: "bridge.subscribe")
        XCTAssertNotNil(host.receive(request, afterReply: { acknowledge = $0 }))
        XCTAssertNil(host.appLifecycleEvent(.foregrounded, for: sid))
        acknowledge?()
        XCTAssertTrue(host.watchesAppLifecycle)
        XCTAssertNil(host.appLifecycleEvent(.backgrounded, for: sid))
        let result = try unpack(host.appLifecycleEvent(.foregrounded, for: sid))
        let event = try XCTUnwrap(result.rpc["params"] as? [String: Any])
        XCTAssertEqual(event["name"] as? String, "app.foregrounded")
        XCTAssertTrue(event["payload"] is NSNull)

        _ = host.receive(echo(id: "off", sid: sid, params: params, method: "bridge.unsubscribe"))
        XCTAssertFalse(host.watchesAppLifecycle)
        XCTAssertNil(host.appLifecycleEvent(.foregrounded, for: sid))
        host.reset()
        _ = try session(host)
        XCTAssertNil(host.appLifecycleEvent(.foregrounded, for: sid))
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

    private func hello(id: String, protocols: String = "[1]", wantsCallbacks: Bool = false) -> String {
        let wants = wantsCallbacks ? #","wants":["callbacks"]"# : ""
        return #"{"jsb":"1.0","rpc":{"jsonrpc":"2.0","id":"\#(id)","method":"bridge.hello","params":{"protocols":\#(protocols)\#(wants)}}}"#
    }

    private func echo(id: String, sid: String, params: String = "{}", method: String = "conformance.echo@1") -> String {
        #"{"jsb":"1.0","meta":{"sid":"\#(sid)","traceId":"trace"},"rpc":{"jsonrpc":"2.0","id":"\#(id)","method":"\#(method)","params":\#(params)}}"#
    }

    private func session(_ host: WireHost, id: String = "hello", wantsCallbacks: Bool = false) throws -> String {
        let reply = try unpack(host.receive(hello(id: id, wantsCallbacks: wantsCallbacks)))
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
