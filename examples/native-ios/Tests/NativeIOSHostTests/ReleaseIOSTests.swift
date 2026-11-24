#if os(iOS) && !DEBUG && !SWIFT_PACKAGE
import NativeIOSHost
import UIKit
import WebKit
import XCTest

final class ReleaseIOSTests: XCTestCase {
    private let origin = URL(string: "https://app.example.test/")!

    @MainActor
    func testReleaseAppDisplaysNativeDeviceAndBusinessResults() async throws {
        let webView = try await waitForAppWebView()
        let output = try await waitForResults(in: webView)

        XCTAssertEqual(output["origin"] as? String, "https://app.example.test")
        XCTAssertEqual(output["state"] as? String, "ready", output["text"] as? String ?? "")
        let encoded = try XCTUnwrap(output["text"] as? String)
        let results = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(encoded.utf8)) as? [String: Any])
        let device = try XCTUnwrap(results["device"] as? [String: String])
        XCTAssertEqual(device["os"], "ios")
        XCTAssertFalse(try XCTUnwrap(device["osVersion"]).isEmpty)
        XCTAssertEqual(results["config"] as? [String: String], ["theme": "system"])
        XCTAssertNotNil(webView.navigationDelegate)
        XCTAssertNil(Bundle.main.object(forInfoDictionaryKey: "NSAppTransportSecurity"))
    }

    @MainActor
    func testReleaseAppPublishesOnlySubscribedBusinessEventsForCurrentDocument() async throws {
        let name = "acme.app.configChanged"
        let unknown = "acme.app.unknown"
        let (webView, delegate) = makeWebView()
        let attachment = try NativeIOSHost.attach(to: webView, allowing: origin, events: [name])
        delegate.attachment = attachment
        defer { attachment.detach() }
        XCTAssertFalse(attachment.emit(name, payload: "before navigation"))

        await loadPage(in: webView, with: delegate, at: origin)
        let helloResult = try await request("bridge.hello", id: "hello", in: webView)
        let hello = try XCTUnwrap(helloResult as? [String: Any])
        let sid = try XCTUnwrap(hello["sid"] as? String)
        let capabilities = try XCTUnwrap(hello["capabilities"] as? [String: Any])
        XCTAssertEqual(capabilities["events"] as? [String], [name])
        try await captureFirstEvent(in: webView)
        XCTAssertFalse(attachment.emit(name, payload: "before subscription"))
        let sub = try await request("bridge.subscribe", id: "subscribe", sid: sid,
                                    params: ["events": [name, unknown]], in: webView)
        XCTAssertEqual(sub as? [String: [String]], ["subscribed": [name], "denied": [unknown]])
        XCTAssertFalse(attachment.emit(unknown, payload: "unregistered"))
        XCTAssertFalse(attachment.emit(name, payload: ["invalid": Date()]))
        XCTAssertTrue(attachment.emit(name, payload: ["theme": "first"]))
        let first = try await nextEvent(in: webView)
        XCTAssertEqual(first["sid"] as? String, sid)
        XCTAssertEqual(first["name"] as? String, name)
        XCTAssertEqual(first["payload"] as? [String: String], ["theme": "first"])

        let off = try await request("bridge.unsubscribe", id: "off", sid: sid, params: ["events": [name]], in: webView)
        XCTAssertEqual(off as? [String: [String]], ["unsubscribed": [name]])
        XCTAssertFalse(attachment.emit(name, payload: "after unsubscribe"))
        _ = try await request("bridge.subscribe", id: "resubscribe", sid: sid, params: ["events": [name]], in: webView)

        await loadPage(in: webView, with: delegate, at: origin.appendingPathComponent("next-events"))
        XCTAssertFalse(attachment.emit(name, payload: "after navigation"))
        let currentSID = try await self.hello(in: webView)
        XCTAssertNotEqual(currentSID, sid)
        try await captureFirstEvent(in: webView)
        let stale = try await request("bridge.subscribe", id: "stale", sid: sid, params: ["events": [name]], in: webView)
        XCTAssertTrue(stale is NSNull)
        XCTAssertFalse(attachment.emit(name, payload: "stale subscription"))
        let current = try await request("bridge.subscribe", id: "subscribe", sid: currentSID,
                                        params: ["events": [name]], in: webView)
        XCTAssertEqual(current as? [String: [String]], ["subscribed": [name], "denied": []])
        XCTAssertTrue(attachment.emit(name, payload: ["theme": "current"]))
        let currentEvent = try await nextEvent(in: webView)
        XCTAssertEqual(currentEvent["sid"] as? String, currentSID)
        XCTAssertEqual(currentEvent["name"] as? String, name)
        XCTAssertEqual(currentEvent["payload"] as? [String: String], ["theme": "current"])
        attachment.detach()
        XCTAssertFalse(attachment.emit(name, payload: "after detach"))
    }

    @MainActor
    func testAttachmentRejectsInvalidOrDuplicateBusinessEventNames() throws {
        let (webView, _) = makeWebView()
        for name in ["configChanged", "bridge.configChanged", "network.changed", "acme.app.configChanged@1"] {
            XCTAssertThrowsError(try NativeIOSHost.attach(to: webView, allowing: origin, events: [name]))
        }
        let name = "acme.app.configChanged"
        XCTAssertThrowsError(try NativeIOSHost.attach(to: webView, allowing: origin, events: [name, name]))
        try NativeIOSHost.attach(to: webView, allowing: origin, events: [name]).detach()
    }

    @MainActor
    private func captureFirstEvent(in webView: WKWebView) async throws {
        _ = try await webView.callAsyncJavaScript("""
            window.firstAppEvent = new Promise(resolve => {
                window.__OJSB_RECEIVE__ = raw => {
                    const {meta, rpc} = JSON.parse(raw);
                    resolve({sid: meta.sid, ...rpc.params});
                };
            });
            return true;
            """, arguments: [:], in: nil, contentWorld: .page)
    }

    @MainActor
    private func nextEvent(in webView: WKWebView) async throws -> [String: Any] {
        let value = try await webView.callAsyncJavaScript("""
            return await Promise.race([window.firstAppEvent,
                new Promise(resolve => setTimeout(() => resolve(null), 3000))]);
            """, arguments: [:], in: nil, contentWorld: .page)
        return try XCTUnwrap(value as? [String: Any])
    }

    @MainActor
    func testDifferentHTTPSPortCannotUseBridge() async throws {
        let (webView, delegate) = makeWebView()
        let attachment = try NativeIOSHost.attach(to: webView, allowing: origin)
        delegate.attachment = attachment
        defer { attachment.detach() }

        await loadPage(in: webView, with: delegate, at: origin)
        _ = try await hello(in: webView)

        let otherPort = URL(string: "https://app.example.test:444/")!
        await loadPage(in: webView, with: delegate, at: otherPort)
        let result = try await webView.callAsyncJavaScript("""
            return {origin: location.origin, transport: typeof window.__OJSB_TRANSPORT__};
            """, arguments: [:], in: nil, contentWorld: .page) as? [String: String]
        XCTAssertEqual(result, ["origin": "https://app.example.test:444", "transport": "undefined"])
    }

    @MainActor
    func testCommittedNavigationCancelsBusinessWorkAndRejectsStaleSession() async throws {
        let started = expectation(description: "Business handler started in the first document")
        let returned = expectation(description: "Business handler returned after cancellation")
        var heldResponse: CheckedContinuation<Void, Never>?
        let business = try NativeIOSHost.BusinessMethod("acme.app.getConfig") { params in
            if params["hold"] as? Bool == true {
                await withCheckedContinuation { continuation in
                    heldResponse = continuation
                    started.fulfill()
                }
                XCTAssertTrue(Task.isCancelled)
                returned.fulfill()
                return ["source": "old"]
            }
            return ["source": "current"]
        }
        let (webView, delegate) = makeWebView()
        let attachment = try NativeIOSHost.attach(to: webView, allowing: origin, methods: [business])
        delegate.attachment = attachment
        defer {
            attachment.detach()
            heldResponse?.resume()
        }
        XCTAssertTrue(webView.navigationDelegate === delegate)

        await loadPage(in: webView, with: delegate, at: origin)
        let first = try await hello(in: webView)
        _ = try await webView.callAsyncJavaScript("""
            void window.__OJSB_TRANSPORT__.postMessage(JSON.stringify({jsb: '1.0', meta: {sid}, rpc: {
                jsonrpc: '2.0', id: 'business', method: 'acme.app.getConfig', params: {hold: true}
            }}));
            return true;
            """, arguments: ["sid": first], in: nil, contentWorld: .page)
        await fulfillment(of: [started], timeout: 5)

        await loadPage(in: webView, with: delegate, at: origin.appendingPathComponent("next"))
        let second = try await hello(in: webView)
        XCTAssertNotEqual(first, second)
        let stale = try await request("acme.app.getConfig", id: "stale", sid: first, in: webView)
        XCTAssertTrue(stale is NSNull)

        let response = try XCTUnwrap(heldResponse)
        heldResponse = nil
        response.resume()
        await fulfillment(of: [returned], timeout: 5)
        let current = try await request("acme.app.getConfig@1", id: "business", sid: second, in: webView) as? [String: String]
        XCTAssertEqual(current, ["source": "current"])
        XCTAssertTrue(webView.navigationDelegate === delegate)
    }

    @MainActor
    func testWireCancellationFreesFullBusinessSlotBeforeFollowingRequest() async throws {
        let started = expectation(description: "Every business slot is in use")
        var cancelledReturned: XCTestExpectation?
        var held = [Int: CheckedContinuation<Void, Never>]()
        let business = try NativeIOSHost.BusinessMethod("acme.app.getConfig") { params in
            guard let index = params["index"] as? Int else { throw NativeIOSHost.BusinessMethodError.invalidParams }
            await withCheckedContinuation { continuation in
                held[index] = continuation
                started.fulfill()
            }
            if index == 0 {
                XCTAssertTrue(Task.isCancelled)
                cancelledReturned?.fulfill()
            }
            return ["index": index]
        }
        let (webView, delegate) = makeWebView()
        let attachment = try NativeIOSHost.attach(to: webView, allowing: origin,
                                                  options: .init(deviceInfo: true), methods: [business])
        delegate.attachment = attachment
        defer {
            attachment.detach()
            held.values.forEach { $0.resume() }
        }

        await loadPage(in: webView, with: delegate, at: origin)
        let helloResult = try await request("bridge.hello", id: "hello", in: webView)
        let handshake = try XCTUnwrap(helloResult as? [String: Any])
        let sid = try XCTUnwrap(handshake["sid"] as? String)
        let limits = try XCTUnwrap(handshake["limits"] as? [String: Int])
        let limit = try XCTUnwrap(limits["maxInflight"])
        started.expectedFulfillmentCount = limit
        _ = try await webView.callAsyncJavaScript("""
            window.postBridgeFrame = (rpc, session = sid, traceId) =>
                window.__OJSB_TRANSPORT__.postMessage(JSON.stringify({
                    jsb: '1.0', meta: {sid: session, traceId}, rpc: {jsonrpc: '2.0', ...rpc}
                }));
            window.heldReplies = Array.from({length: limit}, (_, index) => window.postBridgeFrame({
                method: 'acme.app.getConfig', id: 'held-' + index, params: {index}
            }, sid, 'business-trace'));
            return true;
            """, arguments: ["sid": sid, "limit": limit], in: nil, contentWorld: .page)
        await fulfillment(of: [started], timeout: 10)
        XCTAssertEqual(held.count, limit)

        let invalidResult = try await webView.callAsyncJavaScript("""
            const cancel = {method: 'bridge.cancel', params: {requestId: 'held-0'}};
            const stale = await window.postBridgeFrame(cancel, 'retired-session');
            const malformed = await window.postBridgeFrame({
                ...cancel, params: {...cancel.params, reason: 42}
            });
            const raw = await window.postBridgeFrame({method: 'device.getInfo', id: 'busy'});
            return {silent: stale === null && malformed === null, code: JSON.parse(raw).rpc.error?.code};
            """, arguments: [:], in: nil, contentWorld: .page)
        let ignored = try XCTUnwrap(invalidResult as? [String: Any])
        XCTAssertEqual(ignored["silent"] as? Bool, true)
        XCTAssertEqual(ignored["code"] as? Int, -32008)

        let result = try await webView.callAsyncJavaScript("""
            const cancel = window.postBridgeFrame({method: 'bridge.cancel', params: {requestId: 'held-0'}});
            const next = window.postBridgeFrame({method: 'device.getInfo', id: 'next'});
            const original = await Promise.race([
                window.heldReplies[0], new Promise(resolve => setTimeout(() => resolve(null), 3000))
            ]);
            const reply = JSON.parse(await next);
            return {silent: await cancel === null, original: JSON.parse(original),
                os: reply.rpc.result?.os ?? null, nextCode: reply.rpc.error?.code ?? null};
            """, arguments: [:], in: nil, contentWorld: .page)
        let observed = try XCTUnwrap(result as? [String: Any])
        XCTAssertEqual(observed["silent"] as? Bool, true)
        XCTAssertEqual(observed["os"] as? String, "ios", "Next request must claim the released slot: \(observed)")
        let original = try XCTUnwrap(observed["original"] as? [String: Any])
        let meta = try XCTUnwrap(original["meta"] as? [String: String])
        let rpc = try XCTUnwrap(original["rpc"] as? [String: Any])
        XCTAssertEqual(meta, ["sid": sid, "traceId": "business-trace"])
        XCTAssertEqual(rpc["id"] as? String, "held-0")
        XCTAssertEqual((rpc["error"] as? [String: Any])?["code"] as? Int, -32002)

        let capabilities = try XCTUnwrap(handshake["capabilities"] as? [String: Any])
        XCTAssertTrue((capabilities["features"] as? [String])?.contains("cancel") == true)
        let returned = expectation(description: "Cancelled business task returned")
        cancelledReturned = returned
        let cancelled = try XCTUnwrap(held.removeValue(forKey: 0))
        cancelled.resume()
        await fulfillment(of: [returned], timeout: 5)
        let afterLateReturn = try await request("device.getInfo", id: "after-late-return", sid: sid, in: webView)
        XCTAssertEqual((afterLateReturn as? [String: String])?["os"], "ios")
    }

    @MainActor
    func testDetachCancelsSuspendedBusinessAndDiscardsItsLateResult() async throws {
        let started = expectation(description: "Business handler suspended before detach")
        let returned = expectation(description: "Business handler returned after detach")
        var heldResponse: CheckedContinuation<Void, Never>?
        let business = try NativeIOSHost.BusinessMethod("acme.app.getConfig") { _ in
            await withCheckedContinuation { continuation in
                heldResponse = continuation
                started.fulfill()
            }
            XCTAssertTrue(Task.isCancelled)
            returned.fulfill()
            return ["theme": "late"]
        }
        let (webView, delegate) = makeWebView()
        let attachment = try NativeIOSHost.attach(to: webView, allowing: origin, methods: [business])
        delegate.attachment = attachment
        defer {
            attachment.detach()
            heldResponse?.resume()
        }

        await loadPage(in: webView, with: delegate, at: origin)
        let sid = try await hello(in: webView)
        _ = try await webView.callAsyncJavaScript("""
            window.detachReceipts = [];
            window.__OJSB_RECEIVE__ = raw => window.detachReceipts.push(raw);
            const request = {jsb: '1.0', meta: {sid}, rpc: {
                jsonrpc: '2.0', id: 'suspended', method: 'acme.app.getConfig', params: {}
            }};
            window.detachReply = window.__OJSB_TRANSPORT__.postMessage(JSON.stringify(request)).then(
                raw => window.detachReceipts.push(raw === null ? 'null' : raw),
                error => window.detachReceipts.push(error.name)
            );
            return true;
            """, arguments: ["sid": sid], in: nil, contentWorld: .page)
        await fulfillment(of: [started], timeout: 5)

        attachment.detach()
        let reply = try await webView.callAsyncJavaScript("""
            await Promise.race([window.detachReply, new Promise(resolve => setTimeout(resolve, 3000))]);
            return window.detachReceipts;
            """, arguments: [:], in: nil, contentWorld: .page) as? [String]
        XCTAssertTrue(reply == ["null"] || reply == ["InvalidAccessError"], "Unexpected detach receipt: \(String(describing: reply))")

        let response = try XCTUnwrap(heldResponse)
        heldResponse = nil
        response.resume()
        await fulfillment(of: [returned], timeout: 5)
        let finalReceipts = try await webView.callAsyncJavaScript("return window.detachReceipts;", arguments: [:],
                                                                   in: nil, contentWorld: .page) as? [String]
        XCTAssertEqual(finalReceipts, reply)
    }

    @MainActor
    func testDetachPreservesAppDelegateAndUserScript() async throws {
        let (webView, delegate) = makeWebView()
        webView.configuration.userContentController.addUserScript(.init(
            source: "window.appOwnedScript = 'active';", injectionTime: .atDocumentStart, forMainFrameOnly: true
        ))
        let attachment = try NativeIOSHost.attach(to: webView, allowing: origin, options: .init(deviceInfo: true))
        delegate.attachment = attachment
        defer { attachment.detach() }
        await loadPage(in: webView, with: delegate, at: origin)
        let sid = try await hello(in: webView)
        let active = try await request("device.getInfo", id: "device", sid: sid, in: webView) as? [String: String]
        XCTAssertEqual(active?["os"], "ios")

        attachment.detach()
        XCTAssertTrue(webView.navigationDelegate === delegate)
        let blocked = try await webView.callAsyncJavaScript("""
            const frame = {jsb: '1.0', meta: {sid}, rpc: {
                jsonrpc: '2.0', id: 'detached', method: 'device.getInfo', params: {}
            }};
            try {
                return (await window.__OJSB_TRANSPORT__?.postMessage(JSON.stringify(frame))) == null;
            } catch (error) {
                // WebKit can reject a reference to a removed script message handler.
                return error.name === 'InvalidAccessError';
            }
            """, arguments: ["sid": sid], in: nil, contentWorld: .page) as? Bool
        XCTAssertEqual(blocked, true)

        await loadPage(in: webView, with: delegate, at: origin.appendingPathComponent("after-detach"))
        let appScript = try await webView.callAsyncJavaScript("return window.appOwnedScript;", arguments: [:],
                                                              in: nil, contentWorld: .page) as? String
        XCTAssertEqual(appScript, "active")
    }

    @MainActor
    private func makeWebView() -> (WKWebView, NavigationDelegate) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        let delegate = NavigationDelegate()
        webView.navigationDelegate = delegate
        return (webView, delegate)
    }

    @MainActor
    private func loadPage(in webView: WKWebView, with delegate: NavigationDelegate, at url: URL) async {
        let loaded = expectation(description: "Finished loading \(url.absoluteString)")
        delegate.didFinish = loaded
        webView.loadHTMLString("<!doctype html><title>Release bridge test</title>", baseURL: url)
        // The first navigation also waits for cold WebKit processes on the hosted simulator.
        await fulfillment(of: [loaded], timeout: 20)
    }

    @MainActor
    private func hello(in webView: WKWebView) async throws -> String {
        let result = try await request("bridge.hello", id: "hello", in: webView) as? [String: Any]
        return try XCTUnwrap(result?["sid"] as? String)
    }

    @MainActor
    private func request(_ method: String, id: String, sid: String? = nil,
                         params: [String: Any]? = nil, in webView: WKWebView) async throws -> Any? {
        try await webView.callAsyncJavaScript("""
            const rpc = {jsonrpc: '2.0', id, method, params: params ?? (sid ? {} : {protocols: [1]})};
            const frame = {jsb: '1.0', rpc};
            if (sid) frame.meta = {sid};
            const pending = window.__OJSB_TRANSPORT__?.postMessage(JSON.stringify(frame));
            const raw = await Promise.race([pending, new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 3000))]);
            return raw == null ? null : JSON.parse(raw).rpc.result;
            """, arguments: ["method": method, "id": id, "sid": (sid as Any?) ?? NSNull(),
                               "params": (params as Any?) ?? NSNull()], in: nil, contentWorld: .page)
    }

    @MainActor
    private func waitForAppWebView() async throws -> WKWebView {
        for _ in 0..<60 {
            for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
                for window in scene.windows where window.isKeyWindow {
                    if let webView = firstWebView(in: window) { return webView }
                }
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw TestError(description: "The Release app did not mount a WKWebView")
    }

    @MainActor
    private func firstWebView(in view: UIView) -> WKWebView? {
        if let webView = view as? WKWebView { return webView }
        for subview in view.subviews {
            if let webView = firstWebView(in: subview) { return webView }
        }
        return nil
    }

    @MainActor
    private func waitForResults(in webView: WKWebView) async throws -> [String: Any] {
        for _ in 0..<60 {
            let result = try? await webView.callAsyncJavaScript("""
                const output = document.querySelector('#bridge-results');
                return {origin: location.origin, state: output?.dataset.state ?? '', text: output?.textContent ?? ''};
                """, arguments: [:], in: nil, contentWorld: .page) as? [String: Any]
            if let result, let state = result["state"] as? String, state == "ready" || state == "error" {
                return result
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw TestError(description: "The Release page did not display bridge results")
    }

    private struct TestError: Error, CustomStringConvertible {
        let description: String
    }

    @MainActor
    private final class NavigationDelegate: NSObject, WKNavigationDelegate {
        var attachment: NativeIOSHost.Attachment?
        var didFinish: XCTestExpectation?

        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            attachment?.didCommitNavigation()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            didFinish?.fulfill()
            didFinish = nil
        }
    }
}
#endif
