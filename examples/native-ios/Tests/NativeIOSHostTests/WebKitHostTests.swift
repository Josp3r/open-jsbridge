#if canImport(WebKit)
import WebKit
import XCTest
import NativeIOSHost

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

    @MainActor private func javascript(_ source: String, in webView: WKWebView, arguments: [String: Any] = [:]) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in
            webView.callAsyncJavaScript(source, arguments: arguments, in: nil, in: .page) { result in
                continuation.resume(with: result)
            }
        }
    }
}
#endif
