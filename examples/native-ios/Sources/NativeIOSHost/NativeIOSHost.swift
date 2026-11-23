import WebKit

/// A standalone WebView for exercising the native bridge with the shared Web demo.
public enum NativeIOSHost {
    @MainActor
    public static func makeWebView(allowing originURL: URL) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        #if DEBUG
        if let origin = AllowedOrigin(originURL) {
            let adapter = WebKitHost(origin: origin)
            let controller = configuration.userContentController
            controller.addUserScript(WKUserScript(source: adapter.shim,
                                                 injectionTime: .atDocumentStart,
                                                 forMainFrameOnly: true,
                                                 in: .page))
            // The controller retains the adapter, and the adapter references the WebView weakly.
            controller.addScriptMessageHandler(adapter, contentWorld: .page, name: "ojsb")
            let webView = WKWebView(frame: .zero, configuration: configuration)
            adapter.webView = webView
            webView.navigationDelegate = adapter
            return webView
        }
        #endif
        return WKWebView(frame: .zero, configuration: configuration)
    }
}

private struct AllowedOrigin {
    let scheme: String
    let host: String
    let port: Int

    init?(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty,
              url.user == nil, url.password == nil,
              scheme == "https" || (scheme == "http" && host == "127.0.0.1") else { return nil }
        let port = url.port ?? Self.defaultPort(scheme)
        guard (1...65_535).contains(port) else { return nil }
        self.scheme = scheme
        self.host = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        self.port = port
    }

    @MainActor
    func matches(_ origin: WKSecurityOrigin) -> Bool {
        scheme == origin.`protocol`.lowercased() && host == origin.host.lowercased() &&
            port == (origin.port == 0 ? Self.defaultPort(scheme) : origin.port)
    }

    var serialized: String {
        let authority = host.contains(":") ? "[\(host)]" : host
        let explicitPort = port == Self.defaultPort(scheme) ? "" : ":\(port)"
        return "\(scheme)://\(authority)\(explicitPort)"
    }

    private static func defaultPort(_ scheme: String) -> Int {
        scheme == "https" ? 443 : 80
    }
}

@MainActor
private final class WebKitHost: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    private struct Delivery {
        let document: String
        let raw: String
        let exceedsInflightLimit: Bool
        let reply: (Any?, String?) -> Void

        func finish(_ value: String?) {
            reply(value as Any? ?? NSNull(), nil)
        }
    }

    private let origin: AllowedOrigin
    private let wire = WireHost(platform: "ios")
    private var activeDocument: String?
    private var pending: [Delivery] = []
    private var validating = false
    private var validationEpoch = 0
    private var navigationEpoch = 0
    weak var webView: WKWebView?

    init(origin: AllowedOrigin) {
        self.origin = origin
    }

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let webView, message.webView === webView, message.frameInfo.isMainFrame,
              origin.matches(message.frameInfo.securityOrigin),
              let body = message.body as? [String], body.count == 2,
              body[0].utf8.count == 32, body[0].utf8.allSatisfy({
                  (48...57).contains($0) || (97...102).contains($0)
              }),
              body[1].utf8.count <= WireHost.maxMessageBytes,
              pending.count < WireHost.maxInflight * 2
        else {
            replyHandler(NSNull(), nil)
            return
        }

        // Leave space for ordered, correlated rate-limit responses after authorization.
        pending.append(Delivery(document: body[0], raw: body[1],
                                exceedsInflightLimit: pending.count >= WireHost.maxInflight,
                                reply: replyHandler))
        verifyNext()
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        navigationEpoch += 1
        activeDocument = nil
        wire.reset()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        navigationEpoch += 1
        validationEpoch += 1
        validating = false
        activeDocument = nil
        wire.reset()
        let abandoned = pending
        pending.removeAll()
        abandoned.forEach { $0.finish(nil) }
    }

    private func verifyNext() {
        guard !validating, let webView, let delivery = pending.first else { return }
        validating = true
        validationEpoch += 1
        let validation = validationEpoch
        let navigation = navigationEpoch
        // WKFrameInfo supplies the trusted origin and main-frame bit. A separate
        // check against the current document's immutable shim scopes the reply.
        webView.callAsyncJavaScript(
            "return window.location.origin === allowed && window.__OJSB_MATCH_DOCUMENT__?.(candidate) === true;",
            arguments: ["allowed": origin.serialized, "candidate": delivery.document], in: nil, in: .page
        ) { [weak self] result in
            guard let self, validation == self.validationEpoch else { return }
            self.validating = false
            if navigation == self.navigationEpoch {
                self.pending.removeFirst()
                if (try? result.get()) as? Bool == true {
                    if self.activeDocument != delivery.document {
                        self.wire.reset()
                        self.activeDocument = delivery.document
                    }
                    delivery.finish(self.wire.receive(delivery.raw, exceedsInflightLimit: delivery.exceedsInflightLimit))
                } else {
                    delivery.finish(nil)
                }
            }
            // If a commit happened during evaluation, verify against the new
            // document before touching session state or returning an RPC reply.
            self.verifyNext()
        }
    }

    var shim: String {
        guard let originJSON = try? JSONEncoder().encode(origin.serialized) else { return "" }
        let allowed = String(decoding: originJSON, as: UTF8.self)
        return """
        (() => {
          if (location.origin !== \(allowed) || '__OJSB_TRANSPORT__' in window) return;
          const handler = window.webkit?.messageHandlers?.ojsb;
          if (!handler) return;
          const post = handler.postMessage.bind(handler);
          const documentToken = Array.from(crypto.getRandomValues(new Uint8Array(16)),
            byte => byte.toString(16).padStart(2, '0')).join('');
          Object.defineProperty(window, '__OJSB_MATCH_DOCUMENT__', {
            value: candidate => candidate === documentToken, writable: false, configurable: false
          });
          const transport = Object.freeze({
            name: 'ios-wk',
            protocols: Object.freeze([1]),
            async postMessage(raw) {
              if (typeof raw !== 'string') return null;
              return await post([documentToken, raw]);
            }
          });
          Object.defineProperty(window, '__OJSB_TRANSPORT__', {
            value: transport, writable: false, configurable: false
          });
          window.dispatchEvent(new CustomEvent('ojsb:transportready'));
        })();
        """
    }
}
