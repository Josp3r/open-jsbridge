import WebKit

/// A standalone WebView for exercising the native bridge with the shared Web demo.
public enum NativeIOSHost {
    public struct Options {
        public let deviceInfo: Bool
        public let networkStatus: Bool
        public let networkChanges: Bool

        public init(deviceInfo: Bool = false, networkStatus: Bool = false, networkChanges: Bool = false) {
            self.deviceInfo = deviceInfo
            self.networkStatus = networkStatus
            self.networkChanges = networkChanges
        }
    }

    /// Schedules a response completion. Completion returns true when it sends the protocol frame.
    typealias ReplyScheduler = @MainActor (String, @escaping @MainActor () -> Bool) -> Void

    @MainActor
    public static func makeWebView(allowing originURL: URL) -> WKWebView {
        makeWebView(allowing: originURL, options: .init())
    }

    @MainActor
    public static func makeWebView(allowing originURL: URL, options: Options) -> WKWebView {
        makeWebView(allowing: originURL, options: options) { _, complete in _ = complete() }
    }

    @MainActor
    static func makeWebView(allowing originURL: URL, options: Options = .init(),
                            watchNetwork: NetworkModule.Watch? = nil,
                            scheduleReply: @escaping ReplyScheduler) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        #if DEBUG
        if let origin = AllowedOrigin(originURL) {
            let adapter = WebKitHost(origin: origin, options: options, watchNetwork: watchNetwork, scheduleReply: scheduleReply)
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

/// Owns pending WithReply callbacks for the current WebView document.
@MainActor
final class DeferredReplies {
    private struct Reply {
        let document: String
        let navigation: Int
        let response: String
        let send: (String?) -> Void
    }

    private var pending: [Int: Reply] = [:]
    private var sequence = 0

    var count: Int { pending.count }

    func insert(_ response: String, document: String, navigation: Int, send: @escaping (String?) -> Void) -> Int {
        sequence += 1
        pending[sequence] = Reply(document: document, navigation: navigation, response: response, send: send)
        return sequence
    }

    func complete(_ id: Int, document: String?, navigation: Int) -> Bool {
        // Taking the slot before replying gives navigation and completion one owner of WithReply.
        guard let reply = pending.removeValue(forKey: id) else { return false }
        guard reply.navigation == navigation, reply.document == document else {
            reply.send(nil)
            return false
        }
        reply.send(reply.response)
        return true
    }

    func discard() {
        let abandoned = pending.values
        pending.removeAll()
        abandoned.forEach { $0.send(nil) }
    }
}

@MainActor
private final class WebKitHost: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    private struct Delivery {
        let document: String
        let raw: String
        let exceedsInflightLimit: Bool
        let reply: (String?) -> Void
    }

    private let origin: AllowedOrigin
    private let scheduleReply: NativeIOSHost.ReplyScheduler
    private let wire: WireHost
    private let network: NetworkModule?
    private var activeDocument: String?
    private var pending: [Delivery] = []
    private let deferredReplies = DeferredReplies()
    private var validating = false
    private var validationEpoch = 0
    private var navigationEpoch = 0
    weak var webView: WKWebView?

    init(origin: AllowedOrigin, options: NativeIOSHost.Options, watchNetwork: NetworkModule.Watch?,
         scheduleReply: @escaping NativeIOSHost.ReplyScheduler) {
        self.origin = origin
        self.scheduleReply = scheduleReply
        let network = options.networkStatus || options.networkChanges
            ? NetworkModule(watch: watchNetwork ?? NetworkModule.watchSystemPath) : nil
        self.network = network
        wire = WireHost(platform: "ios", options: options, networkType: { network?.type ?? .unknown })
    }

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let outstanding = pending.count + deferredReplies.count
        guard let webView, message.webView === webView, message.frameInfo.isMainFrame,
              origin.matches(message.frameInfo.securityOrigin),
              let body = message.body as? [String], body.count == 2,
              body[0].utf8.count == 32, body[0].utf8.allSatisfy({
                  (48...57).contains($0) || (97...102).contains($0)
              }),
              body[1].utf8.count <= WireHost.maxMessageBytes,
              outstanding < WireHost.maxInflight * 2
        else {
            replyHandler(NSNull(), nil)
            return
        }

        // Leave space for ordered, correlated rate-limit responses after authorization.
        pending.append(Delivery(document: body[0], raw: body[1],
                                exceedsInflightLimit: outstanding >= WireHost.maxInflight,
                                reply: { replyHandler($0 as Any? ?? NSNull(), nil) }))
        verifyNext()
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        navigationEpoch += 1
        resetDocument()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        navigationEpoch += 1
        validationEpoch += 1
        validating = false
        resetDocument()
        let abandoned = pending
        pending.removeAll()
        abandoned.forEach { $0.reply(nil) }
    }

    private func resetDocument() {
        activeDocument = nil
        wire.reset()
        network?.stop()
        deferredReplies.discard()
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
                        self.resetDocument()
                        self.activeDocument = delivery.document
                    }
                    var acknowledge: (() -> Void)?
                    if let response = self.wire.receive(delivery.raw, exceedsInflightLimit: delivery.exceedsInflightLimit,
                                                        afterReply: { acknowledge = $0 }) {
                        self.updateNetworkObservation()
                        self.queueReply(response, for: delivery, acknowledge: acknowledge)
                    } else {
                        delivery.reply(nil)
                    }
                } else {
                    delivery.reply(nil)
                }
            }
            // If a commit happened during evaluation, verify against the new
            // document before touching session state or returning an RPC reply.
            self.verifyNext()
        }
    }

    private func queueReply(_ response: String, for delivery: Delivery, acknowledge: (() -> Void)?) {
        let id = deferredReplies.insert(response, document: delivery.document,
                                        navigation: navigationEpoch, send: delivery.reply)
        scheduleReply(response) { [weak self] in
            guard let self, self.deferredReplies.complete(id, document: self.activeDocument, navigation: self.navigationEpoch)
            else { return false }
            if let acknowledge {
                acknowledge()
                self.updateNetworkObservation()
            }
            return true
        }
    }

    private func updateNetworkObservation() {
        guard let network else { return }
        guard wire.watchesNetwork, let sid = wire.sid, let document = activeDocument else {
            network.stop()
            return
        }
        network.start { [weak self] type in
            guard let self, self.activeDocument == document, let webView = self.webView,
                  let raw = self.wire.networkEvent(type, for: sid) else { return }
            // Keep identity validation and delivery in the same WebKit evaluation.
            webView.callAsyncJavaScript(
                "return window.location.origin === allowed && window.__OJSB_DELIVER__?.(candidate, raw) === true;",
                arguments: ["allowed": self.origin.serialized, "candidate": document, "raw": raw], in: nil, in: .page
            )
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
          const newDocumentToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
            byte => byte.toString(16).padStart(2, '0')).join('');
          let documentToken = newDocumentToken();
          Object.defineProperty(window, '__OJSB_MATCH_DOCUMENT__', {
            value: candidate => candidate === documentToken, writable: false, configurable: false
          });
          const pending = [];
          let receive;
          Object.defineProperty(window, '__OJSB_RECEIVE__', {
            get: () => receive,
            set(callback) {
              receive = typeof callback === 'function' ? callback : undefined;
              while (receive && pending.length) {
                try { receive(pending.shift()); }
                catch (error) { queueMicrotask(() => { throw error; }); }
              }
            }
          });
          Object.defineProperty(window, '__OJSB_DELIVER__', {
            value(candidate, raw) {
              if (candidate !== documentToken) return false;
              if (receive) receive(raw);
              else if (pending.length < 256) pending.push(raw);
              return true;
            }
          });
          window.addEventListener('pagehide', () => {
            // A document restored from the back-forward cache negotiates a fresh route.
            documentToken = newDocumentToken();
            pending.length = 0;
            receive = undefined;
            // Verify the rotated token so the adapter can cancel its old route even
            // when WebKit does not report a new document commit.
            void post([documentToken, '']).catch(() => {});
          }, { capture: true });
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
