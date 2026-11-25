#if canImport(WebKit) && DEBUG
import WebKit
import XCTest
@testable import NativeIOSHost

final class WebKitHostTests: XCTestCase {
    private let url = URL(string: "http://127.0.0.1:4173/?host=native")!

    override func setUpWithError() throws {
        #if os(macOS)
        try XCTSkipUnless(ProcessInfo.processInfo.environment["OJSB_WEBKIT_E2E"] == "1",
                          "Set OJSB_WEBKIT_E2E=1 and start npm run demo:web to test macOS WebKit.")
        #endif
    }

    @MainActor
    func testExistingWebDemoConnectsAndEchoesThroughNativeWebKit() async throws {
        let webView = try await loadDemo()
        let sample = "你好 Swift 👋"
        let result = try await javascript("""
            document.querySelector('#message').value = sample;
            document.querySelector('#send').click();
            for (let i = 0; i < 60; i++) {
                const status = document.querySelector('#connection-status');
                if (status.dataset.state === 'ready' &&
                    document.querySelector('#result').textContent.includes(sample)) {
                    const result = JSON.parse(document.querySelector('#result').textContent);
                    return {platform: status.dataset.platform, result};
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error(document.querySelector('#result').textContent);
            """, in: webView, arguments: ["sample": sample]) as? [String: Any]
        XCTAssertEqual(result?["platform"] as? String, "ios")
        XCTAssertEqual(result?["result"] as? [String: String], ["text": sample])
    }

    @MainActor
    func testNavigationReplacesSessionAndHistoryKeepsIt() async throws {
        let webView = try await loadDemo()
        let before = try await hello(in: webView, id: "raw-first")
        _ = try await javascript("history.pushState({}, '', '#same-document'); return true;", in: webView)
        let afterHistory = try await hello(in: webView, id: "raw-history")
        XCTAssertEqual(afterHistory, before)

        let newURL = URL(string: "http://127.0.0.1:4173/?host=native&navigation=next")!
        webView.load(URLRequest(url: newURL))
        try await waitForPage(webView, url: newURL)
        let afterNavigation = try await hello(in: webView, id: "raw-first")
        XCTAssertNotEqual(afterNavigation, before)
        let replay = try await javascript("""
            return await window.__OJSB_TRANSPORT__.postMessage(JSON.stringify({
                jsb: '1.0', meta: {sid: oldSID},
                rpc: {jsonrpc: '2.0', id: 'old-echo', method: 'conformance.echo', params: {text: 'old'}}
            }));
            """, in: webView, arguments: ["oldSID": before])
        XCTAssertTrue(replay is NSNull)
    }

    @MainActor
    func testNetworkPushWaitsForAcknowledgementAndStaysInSubscribedDocument() async throws {
        let heldSubscribe = expectation(description: "Network subscribe before acknowledgement")
        var acknowledge: (@MainActor () -> Bool)?
        var updates: [NetworkModule.Update] = []
        var cancellations = 0
        let webView = NativeIOSHost.makeWebView(
            allowing: url,
            options: .init(networkStatus: true, networkChanges: true),
            watchNetwork: { update in
                updates.append(update)
                return { cancellations += 1 }
            }
        ) { response, complete in
            if response.contains("\"hold-subscribe\"") {
                acknowledge = complete
                heldSubscribe.fulfill()
            } else {
                _ = complete()
            }
        }
        webView.load(URLRequest(url: url))
        try await waitForPage(webView, url: url)
        let sid = try await hello(in: webView, id: "network-hello")
        let update = try XCTUnwrap(updates.first)
        _ = try await javascript("""
            window.networkReplies = {};
            window.networkFrames = [];
            window.__OJSB_RECEIVE__ = raw => window.networkFrames.push(JSON.parse(raw));
            void window.__OJSB_TRANSPORT__.postMessage(JSON.stringify({jsb: '1.0', meta: {sid}, rpc: {
                jsonrpc: '2.0', id: 'hold-subscribe', method: 'bridge.subscribe', params: {events: ['network.statusChanged']}
            }})).then(raw => window.networkReplies.subscribe = JSON.parse(raw));
            return true;
            """, in: webView, arguments: ["sid": sid])
        await fulfillment(of: [heldSubscribe], timeout: 5)
        update(.wifi)
        let beforeAcknowledgement = try await javascript("return window.networkFrames.length;", in: webView) as? Int
        XCTAssertEqual(beforeAcknowledgement, 0)
        XCTAssertTrue(try XCTUnwrap(acknowledge)())
        try await poll(webView, predicate: "window.networkReplies.subscribe?.rpc.result.subscribed[0] === 'network.statusChanged'")

        _ = try await javascript("window.__OJSB_RECEIVE__ = undefined; return true;", in: webView)
        update(.cellular)
        update(.cellular)
        update(.ethernet)
        let frames = try await javascript("""
            window.__OJSB_RECEIVE__ = raw => window.networkFrames.push(JSON.parse(raw));
            return window.networkFrames.map(frame => [frame.meta.sid, frame.rpc.method, frame.rpc.params.name, frame.rpc.params.payload.type]);
            """, in: webView) as? [[String]]
        XCTAssertEqual(frames, [
            [sid, "bridge.event", "network.statusChanged", "cellular"],
            [sid, "bridge.event", "network.statusChanged", "ethernet"]
        ])
        let status = try await request(in: webView, sid: sid, id: "status", method: "network.getStatus@1")
        XCTAssertEqual(status["result"] as? [String: String], ["type": "ethernet"])
        let unsubscribe = try await request(in: webView, sid: sid, id: "unsubscribe", method: "bridge.unsubscribe@1",
                                            params: ["events": ["network.statusChanged"]])
        XCTAssertEqual(unsubscribe["result"] as? [String: [String]], ["unsubscribed": ["network.statusChanged"]])
        update(.other)
        let afterUnsubscribe = try await javascript("return window.networkFrames.length;", in: webView) as? Int
        XCTAssertEqual(afterUnsubscribe, 2)

        _ = try await request(in: webView, sid: sid, id: "subscribe-again", method: "bridge.subscribe@1",
                              params: ["events": ["network.statusChanged"]])
        let nextURL = URL(string: "http://127.0.0.1:4173/?host=native&navigation=network")!
        webView.load(URLRequest(url: nextURL))
        try await waitForPage(webView, url: nextURL)
        let nextSID = try await hello(in: webView, id: "network-hello")
        XCTAssertNotEqual(nextSID, sid)
        XCTAssertEqual(cancellations, 1)
        let nextUpdate = try XCTUnwrap(updates.last)
        _ = try await javascript("""
            window.networkFrames = [];
            window.__OJSB_RECEIVE__ = raw => window.networkFrames.push(JSON.parse(raw));
            return true;
            """, in: webView)
        nextUpdate(.wifi)
        update(.cellular)
        let beforeNewSubscription = try await javascript("return window.networkFrames.length;", in: webView) as? Int
        XCTAssertEqual(beforeNewSubscription, 0)
        _ = try await request(in: webView, sid: nextSID, id: "subscribe", method: "bridge.subscribe",
                              params: ["events": ["network.statusChanged"]])
        update(.other)
        nextUpdate(.none)
        try await poll(webView, predicate: "window.networkFrames.length === 1")
        let newFrame = try await javascript("return window.networkFrames[0];", in: webView) as? [String: Any]
        XCTAssertEqual((newFrame?["meta"] as? [String: String])?["sid"], nextSID)
        let rpc = newFrame?["rpc"] as? [String: Any]
        let params = rpc?["params"] as? [String: Any]
        XCTAssertEqual(params?["payload"] as? [String: String], ["type": "none"])
    }

    @MainActor
    func testPageHideClearsBufferedEventsAndCancelsObservationBeforeNextHandshake() async throws {
        var update: NetworkModule.Update?
        let cancelled = expectation(description: "Observer released on pagehide")
        let webView = NativeIOSHost.makeWebView(allowing: url, options: .init(networkChanges: true),
                                               watchNetwork: { callback in
            update = callback
            return { cancelled.fulfill() }
        }) { _, complete in _ = complete() }
        webView.load(URLRequest(url: url))
        try await waitForPage(webView, url: url)
        let sid = try await hello(in: webView, id: "pagehide-hello")
        _ = try await request(in: webView, sid: sid, id: "subscribe", method: "bridge.subscribe",
                              params: ["events": ["network.statusChanged"]])
        let send = try XCTUnwrap(update)
        _ = try await javascript("window.__OJSB_RECEIVE__ = undefined; return true;", in: webView)
        send(.wifi)
        let bufferedCount = try await javascript("""
            window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
            window.receiptsAfterPageHide = [];
            window.__OJSB_RECEIVE__ = raw => window.receiptsAfterPageHide.push(raw);
            return window.receiptsAfterPageHide.length;
            """, in: webView) as? Int
        XCTAssertEqual(bufferedCount, 0)
        await fulfillment(of: [cancelled], timeout: 5)

        let resumedSID = try await hello(in: webView, id: "pagehide-hello")
        XCTAssertNotEqual(resumedSID, sid)
        send(.cellular)
        let delivery = try await javascript("""
            const reachedReceiver = window.__OJSB_DELIVER__('0'.repeat(32), '{"unexpected":true}');
            return {reachedReceiver, count: window.receiptsAfterPageHide.length};
            """, in: webView) as? [String: Any]
        XCTAssertEqual(delivery?["reachedReceiver"] as? Bool, false)
        XCTAssertEqual(delivery?["count"] as? Int, 0)
    }

    @MainActor
    func testSystemProvidersExposeDeviceAndNetworkSnapshots() async throws {
        let webView = NativeIOSHost.makeWebView(allowing: url, options: .init(deviceInfo: true, networkStatus: true))
        webView.load(URLRequest(url: url))
        try await waitForPage(webView, url: url)
        let sid = try await hello(in: webView, id: "system-providers")
        let response = try await request(in: webView, sid: sid, id: "system-info", method: "device.getInfo@1")
        let info = try XCTUnwrap(response["result"] as? [String: String])
        XCTAssertEqual(info["os"], "ios")
        XCTAssertFalse(try XCTUnwrap(info["osVersion"]).isEmpty)

        for attempt in 0..<50 {
            let response = try await request(in: webView, sid: sid, id: "system-status-\(attempt)", method: "network.getStatus")
            let status = try XCTUnwrap(response["result"] as? [String: String])
            let type = try XCTUnwrap(status["type"])
            if type != "unknown" {
                XCTAssertTrue(["wifi", "cellular", "ethernet", "other", "none"].contains(type))
                return
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("NWPathMonitor did not report an initial network type")
    }

    @MainActor
    func testLateEchoCannotReachNewDocumentOrSettleWithReplyTwice() async throws {
        let oldPending = expectation(description: "Old document's native echo completion")
        let newPending = expectation(description: "New document's native echo completion")
        var releaseOld: (@MainActor () -> Bool)?
        var releaseNew: (@MainActor () -> Bool)?
        let webView = NativeIOSHost.makeWebView(allowing: url) { response, complete in
            if response.contains("old-document-value") {
                releaseOld = complete
                oldPending.fulfill()
            } else if response.contains("new-document-value") {
                releaseNew = complete
                newPending.fulfill()
            } else {
                _ = complete()
            }
        }

        webView.load(URLRequest(url: url))
        try await waitForPage(webView, url: url)
        let oldSID = try await hello(in: webView, id: "response-lifecycle-hello")
        try await startRawEcho(in: webView, sid: oldSID, text: "old-document-value")
        await fulfillment(of: [oldPending], timeout: 6)
        let oldCompletion = try XCTUnwrap(releaseOld)

        let newURL = URL(string: "http://127.0.0.1:4173/?host=native&navigation=late-reply")!
        webView.load(URLRequest(url: newURL))
        try await waitForPage(webView, url: newURL)
        let newSID = try await hello(in: webView, id: "response-lifecycle-hello")
        XCTAssertNotEqual(oldSID, newSID)
        // Both calls use the same RPC ID to catch delivery to a new document's pending call.
        try await startRawEcho(in: webView, sid: newSID, text: "new-document-value")
        await fulfillment(of: [newPending], timeout: 6)
        let newCompletion = try XCTUnwrap(releaseNew)

        let oldResponseSent = oldCompletion()
        XCTAssertFalse(oldResponseSent, "Navigation must retire the original native reply before it completes")
        guard !oldResponseSent else { return }
        XCTAssertFalse(oldCompletion(), "Repeating a canceled completion must be harmless")
        let beforeNewCompletion = try await javascript("return [...window.echoReplies, ...window.pushFrames];", in: webView) as? [String]
        XCTAssertEqual(beforeNewCompletion, [])

        XCTAssertTrue(newCompletion(), "The current document's withheld reply must still be deliverable")
        XCTAssertFalse(newCompletion(), "WithReply must be invoked at most once")
        try await poll(webView, predicate: "window.echoReplies.length === 1")
        let result = try await javascript("""
            const {meta, rpc} = JSON.parse(window.echoReplies[0]);
            return {sid: meta.sid, id: rpc.id, text: rpc.result.text, pushCount: window.pushFrames.length};
            """, in: webView) as? [String: Any]
        XCTAssertEqual(result?["sid"] as? String, newSID)
        XCTAssertEqual(result?["id"] as? String, "echo-during-navigation")
        XCTAssertEqual(result?["text"] as? String, "new-document-value")
        XCTAssertEqual(result?["pushCount"] as? Int, 0)
    }

    @MainActor
    func testDocumentStartShimAndInflightLimit() async throws {
        let webView = NativeIOSHost.makeWebView(allowing: url)
        webView.loadHTMLString("""
            <!doctype html><script>
            const transport = window.__OJSB_TRANSPORT__;
            const descriptor = Object.getOwnPropertyDescriptor(window, '__OJSB_TRANSPORT__');
            window.earlyHandshake = null;
            if (Object.isFrozen(transport) && Object.isFrozen(transport.protocols) &&
                !descriptor.writable && !descriptor.configurable) {
                transport.postMessage(JSON.stringify({jsb: '1.0', rpc: {
                    jsonrpc: '2.0', id: 'early', method: 'bridge.hello', params: {protocols: [1]}
                }})).then(raw => window.earlyHandshake = JSON.parse(raw)?.rpc?.result);
            }
            </script>
            """, baseURL: url)
        try await poll(webView, predicate: "window.earlyHandshake?.sid !== undefined")
        let summary = try await javascript("""
            const {sid, limits} = window.earlyHandshake;
            const requests = Array.from({length: limits.maxInflight + 1}, (_, i) =>
                window.__OJSB_TRANSPORT__.postMessage(JSON.stringify({jsb: '1.0', meta: {sid}, rpc: {
                    jsonrpc: '2.0', id: 'burst-' + i, method: 'conformance.echo', params: {i}
                }})));
            const replies = await Promise.all(requests);
            return replies.map(reply => {
                const rpc = JSON.parse(reply)?.rpc;
                return rpc?.error?.code ?? rpc?.result?.i ?? -1;
            });
            """, in: webView) as? [Int]
        XCTAssertEqual(summary, Array(0..<64) + [-32008])
    }

    @MainActor
    func testUntrustedDocumentAndChildFrameCannotUseRawHandler() async throws {
        let webView = try await loadDemo()
        let trustedSID = try await hello(in: webView, id: "trusted-before-child")
        let child = try await javascript("""
            const frame = document.createElement('iframe');
            frame.srcdoc = '<!doctype html><title>same-origin child</title>';
            const loaded = new Promise(resolve => frame.onload = resolve);
            document.body.append(frame);
            await loaded;
            const child = frame.contentWindow;
            const receipt = await child.webkit.messageHandlers.ojsb.postMessage(
                [documentToken, JSON.stringify(hello)]
            );
            return {shim: typeof child.__OJSB_TRANSPORT__, dropped: receipt === null};
            """, in: webView, arguments: ["documentToken": String(repeating: "0", count: 32), "hello": rawHello]) as? [String: Any]
        XCTAssertEqual(child?["shim"] as? String, "undefined")
        XCTAssertEqual(child?["dropped"] as? Bool, true)
        let currentSID = try await hello(in: webView, id: "trusted-after-child")
        XCTAssertEqual(trustedSID, currentSID)

        // Same address and a different port still form distinct origins.
        let untrusted = URL(string: "http://127.0.0.1:4174/")!
        webView.loadHTMLString("<!doctype html><title>different origin</title>", baseURL: untrusted)
        try await poll(webView, predicate: "document.title === 'different origin'")
        let other = try await javascript("""
            // Even a page that installs a counterfeit verifier cannot pass the native origin check.
            window.__OJSB_MATCH_DOCUMENT__ = () => true;
            const receipt = await window.webkit.messageHandlers.ojsb.postMessage(
                [documentToken, JSON.stringify({...hello, meta: {origin: 'http://127.0.0.1:4173'}})]
            );
            return {shim: typeof window.__OJSB_TRANSPORT__, dropped: receipt === null};
            """, in: webView, arguments: ["documentToken": String(repeating: "0", count: 32), "hello": rawHello]) as? [String: Any]
        XCTAssertEqual(other?["shim"] as? String, "undefined")
        XCTAssertEqual(other?["dropped"] as? Bool, true)
    }

    private var rawHello: [String: Any] {
        ["jsb": "1.0", "rpc": ["jsonrpc": "2.0", "id": "raw-hello", "method": "bridge.hello", "params": ["protocols": [1]]]]
    }

    @MainActor private func loadDemo() async throws -> WKWebView {
        let webView = NativeIOSHost.makeWebView(allowing: url)
        webView.load(URLRequest(url: url))
        try await waitForPage(webView, url: url)
        return webView
    }

    @MainActor private func waitForPage(_ webView: WKWebView, url: URL) async throws {
        try await poll(webView,
                       predicate: "location.href === targetURL && document.querySelector('#send')?.disabled === false",
                       arguments: ["targetURL": url.absoluteString])
    }

    @MainActor private func poll(_ webView: WKWebView, predicate: String, arguments: [String: Any] = [:]) async throws {
        for _ in 0..<60 {
            if (try? await javascript("return \(predicate);", in: webView, arguments: arguments)) as? Bool == true {
                return
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw NSError(domain: "WebKitHostTests", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Page did not become ready. Run npm run demo:web at http://127.0.0.1:4173/. URL: \(webView.url?.absoluteString ?? "unknown")"
        ])
    }

    @MainActor private func hello(in webView: WKWebView, id: String) async throws -> String {
        let sid = try await javascript("""
            hello.rpc.id = id;
            const raw = await window.__OJSB_TRANSPORT__.postMessage(JSON.stringify(hello));
            return JSON.parse(raw)?.rpc?.result?.sid ?? null;
            """, in: webView, arguments: ["hello": rawHello, "id": id]) as? String
        return try XCTUnwrap(sid)
    }

    @MainActor private func request(in webView: WKWebView, sid: String, id: String,
                                    method: String, params: [String: Any] = [:]) async throws -> [String: Any] {
        let reply = try await javascript("""
            const raw = await window.__OJSB_TRANSPORT__.postMessage(JSON.stringify({
                jsb: '1.0', meta: {sid}, rpc: {jsonrpc: '2.0', id, method, params}
            }));
            return JSON.parse(raw)?.rpc ?? null;
            """, in: webView, arguments: ["sid": sid, "id": id, "method": method, "params": params])
        return try XCTUnwrap(reply as? [String: Any])
    }

    @MainActor private func startRawEcho(in webView: WKWebView, sid: String, text: String) async throws {
        _ = try await javascript("""
            window.echoReplies = [];
            window.pushFrames = [];
            window.__OJSB_RECEIVE__ = raw => window.pushFrames.push(raw);
            void window.__OJSB_TRANSPORT__.postMessage(JSON.stringify({
                jsb: '1.0', meta: {sid},
                rpc: {jsonrpc: '2.0', id: 'echo-during-navigation', method: 'conformance.echo', params: {text}}
            })).then(raw => window.echoReplies.push(raw));
            return true;
            """, in: webView, arguments: ["sid": sid, "text": text])
    }

    @MainActor private func javascript(_ source: String, in webView: WKWebView, arguments: [String: Any] = [:]) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in
            webView.callAsyncJavaScript(source, arguments: arguments, in: nil, in: .page) { result in
                continuation.resume(with: result)
            }
        }
    }
}
final class DeferredRepliesTests: XCTestCase {
    @MainActor
    func testDiscardSettlesNativeReplyWithNullExactlyOnce() async {
        let replies = DeferredReplies()
        var receipts: [String?] = []
        let id = replies.insert("old response", document: "old", navigation: 1) {
            receipts.append($0)
        }

        replies.discard()
        XCTAssertEqual(receipts, [nil])
        XCTAssertFalse(replies.complete(id, document: "new", navigation: 2))
        replies.discard()
        XCTAssertEqual(receipts, [nil])
    }
}
#endif
