import Network
import WebKit

/// Hosts the native bridge in an app-owned WebView or the standalone Debug demo.
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

    public enum AttachmentError: Error, Equatable {
        case invalidOrigin
        case webViewAlreadyLoaded
        case alreadyAttached
    }

    @MainActor
    public final class Attachment {
        private var host: WebKitHost?
        private weak var controller: WKUserContentController?

        fileprivate init(host: WebKitHost, controller: WKUserContentController) {
            self.host = host
            self.controller = controller
        }

        /// Forward the WebView's main-frame navigation commit to retire the previous route.
        public func didCommitNavigation() {
            host?.didCommitNavigation()
        }

        /// Forward WebKit's content process termination to clear the document and its pending work.
        public func webContentProcessDidTerminate() {
            host?.webContentProcessDidTerminate()
        }

        /// Cancels outstanding work and removes the bridge's script message handler.
        public func detach() {
            guard let host else { return }
            self.host = nil
            NativeIOSHost.detach(host, from: controller)
        }
    }

    @MainActor
    private static let attachments = NSMapTable<WKUserContentController, WebKitHost>.weakToWeakObjects()

    /// Installs the bridge for one HTTPS origin. Call before the app's first navigation.
    /// Retain the attachment and forward lifecycle callbacks from the app's navigation delegate.
    @MainActor
    public static func attach(to webView: WKWebView, allowing originURL: URL,
                              options: Options = .init(), methods: [BusinessMethod] = []) throws -> Attachment {
        guard let origin = AllowedOrigin(originURL) else { throw AttachmentError.invalidOrigin }
        let controller = webView.configuration.userContentController
        let previous = attachments.object(forKey: controller)
        guard previous?.webView == nil else { throw AttachmentError.alreadyAttached }
        guard webView.url == nil, !webView.isLoading, webView.backForwardList.currentItem == nil else {
            throw AttachmentError.webViewAlreadyLoaded
        }

        var handlers: [String: BusinessMethod.Handler] = [:]
        for method in methods {
            guard handlers.updateValue(method.handler, forKey: method.name) == nil else {
                throw BusinessMethodError.duplicateName(method.name)
            }
        }
        if let previous { detach(previous, from: controller) }

        let handlerName = "ojsb_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let host = WebKitHost(origin: origin, options: options, businessMethods: handlers,
                              enableEcho: false, handlerName: handlerName, watchNetwork: nil) { _, complete in
            _ = complete()
        }
        host.webView = webView
        host.install(in: controller)
        attachments.setObject(host, forKey: controller)
        return Attachment(host: host, controller: controller)
    }

    @MainActor
    private static func detach(_ host: WebKitHost, from controller: WKUserContentController?) {
        if let controller, attachments.object(forKey: controller) === host {
            attachments.removeObject(forKey: controller)
            host.uninstall(from: controller)
        }
        host.webView = nil
        host.webContentProcessDidTerminate()
    }

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
        if let origin = AllowedOrigin(originURL, forDemo: true) {
            let adapter = WebKitHost(origin: origin, options: options, businessMethods: [:],
                                     enableEcho: true, handlerName: "ojsb", watchNetwork: watchNetwork,
                                     scheduleReply: scheduleReply)
            let controller = configuration.userContentController
            adapter.install(in: controller)
            let webView = WKWebView(frame: .zero, configuration: configuration)
            adapter.webView = webView
            webView.navigationDelegate = adapter
            attachments.setObject(adapter, forKey: controller)
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

    init?(_ url: URL, forDemo: Bool = false) {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty,
              url.user == nil, url.password == nil,
              scheme == "https" || (forDemo && scheme == "http" && host == "127.0.0.1") else { return nil }
        let port = url.port
        var normalizedHost = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if !forDemo {
            guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let encodedHost = components.percentEncodedHost,
                  components.scheme != nil, components.query == nil, components.fragment == nil,
                  port != nil || components.rangeOfPort == nil,
                  components.percentEncodedPath.isEmpty || components.percentEncodedPath == "/"
            else { return nil }
            let forbidden = CharacterSet.controlCharacters.union(.whitespacesAndNewlines)
                .union(CharacterSet(charactersIn: "#%/<>?@[\\]^|"))
            let bracketed = encodedHost.hasPrefix("[")
            guard (bracketed ? normalizedHost : host).rangeOfCharacter(from: forbidden) == nil else { return nil }
            if bracketed {
                guard let address = IPv6Address(normalizedHost) else { return nil }
                normalizedHost = Self.serializedIPv6Host(address)
            } else {
                guard !host.contains(":"), !Self.endsInNumber(host) || IPv4Address(host)?.debugDescription == host
                else { return nil }
            }
        }
        let effectivePort = port ?? Self.defaultPort(scheme)
        guard (1...65_535).contains(effectivePort) else { return nil }
        self.scheme = scheme
        self.host = normalizedHost
        self.port = effectivePort
    }

    @MainActor
    func matches(_ origin: WKSecurityOrigin) -> Bool {
        scheme == origin.`protocol`.lowercased() &&
            host == origin.host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]")) &&
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

    /// WebKit treats a host ending in a decimal or hexadecimal label as an IPv4 address.
    private static func endsInNumber(_ host: String) -> Bool {
        guard let last = host.split(separator: ".").last else { return false }
        if last.utf8.allSatisfy({ (48...57).contains($0) }) { return true }
        return last.hasPrefix("0x") && last.utf8.dropFirst(2).allSatisfy {
            (48...57).contains($0) || (97...102).contains($0)
        }
    }

    private static func serializedIPv6Host(_ address: IPv6Address) -> String {
        let compressed = address.debugDescription
        guard compressed.contains("."), let lastColon = compressed.lastIndex(of: ":") else { return compressed }
        // WebKit serializes the last two IPv6 groups as hex even for an embedded IPv4 address.
        let bytes = Array(address.rawValue.suffix(4))
        let first = UInt16(bytes[0]) << 8 | UInt16(bytes[1])
        let second = UInt16(bytes[2]) << 8 | UInt16(bytes[3])
        return "\(compressed[...lastColon])\(String(first, radix: 16)):\(String(second, radix: 16))"
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

    private struct BusinessWork {
        let task: Task<Void, Never>
        let reply: (String?) -> Void
    }

    private let origin: AllowedOrigin
    private let handlerName: String
    private let scheduleReply: NativeIOSHost.ReplyScheduler
    private let wire: WireHost
    private let network: NetworkModule?
    private var activeDocument: String?
    private var pending: [Delivery] = []
    private var businessWork: [UUID: BusinessWork] = [:]
    private let deferredReplies = DeferredReplies()
    private var validating = false
    private var validationEpoch = 0
    private var navigationEpoch = 0
    private var userScript: WKUserScript?
    weak var webView: WKWebView?

    init(origin: AllowedOrigin, options: NativeIOSHost.Options,
         businessMethods: [String: NativeIOSHost.BusinessMethod.Handler], enableEcho: Bool, handlerName: String,
         watchNetwork: NetworkModule.Watch?,
         scheduleReply: @escaping NativeIOSHost.ReplyScheduler) {
        self.origin = origin
        self.handlerName = handlerName
        self.scheduleReply = scheduleReply
        let network = options.networkStatus || options.networkChanges
            ? NetworkModule(watch: watchNetwork ?? NetworkModule.watchSystemPath) : nil
        self.network = network
        wire = WireHost(platform: "ios", options: options, businessMethods: businessMethods, enableEcho: enableEcho,
                        networkType: { network?.type ?? .unknown })
    }

    func install(in controller: WKUserContentController) {
        let script = WKUserScript(source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page)
        userScript = script
        controller.addUserScript(script)
        // The controller retains this handler. Its reference to the WebView is weak.
        controller.addScriptMessageHandler(self, contentWorld: .page, name: handlerName)
    }

    func uninstall(from controller: WKUserContentController) {
        controller.removeScriptMessageHandler(forName: handlerName, contentWorld: .page)
        var scripts = controller.userScripts
        guard let index = scripts.firstIndex(where: { $0 === userScript }) else { return }
        // WebKit only supports removing scripts as a group. Restore the app's original instances in order.
        scripts.remove(at: index)
        controller.removeAllUserScripts()
        scripts.forEach(controller.addUserScript)
    }

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let outstanding = pending.count + deferredReplies.count + businessWork.count
        guard let webView, message.webView === webView, message.name == handlerName,
              message.frameInfo.isMainFrame,
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
        didCommitNavigation()
    }

    func didCommitNavigation() {
        navigationEpoch += 1
        resetDocument()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webContentProcessDidTerminate()
    }

    func webContentProcessDidTerminate() {
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
        let abandoned = businessWork.values
        businessWork.removeAll()
        for work in abandoned {
            work.task.cancel()
            work.reply(nil)
        }
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
                    var businessCall: WireHost.BusinessCall?
                    if let response = self.wire.receive(delivery.raw, exceedsInflightLimit: delivery.exceedsInflightLimit,
                                                        onBusinessCall: { businessCall = $0 },
                                                        afterReply: { acknowledge = $0 }) {
                        self.updateNetworkObservation()
                        self.queueReply(response, document: delivery.document, send: delivery.reply,
                                        acknowledge: acknowledge)
                    } else if let businessCall {
                        self.start(businessCall, for: delivery)
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

    private func start(_ call: WireHost.BusinessCall, for delivery: Delivery) {
        let id = UUID()
        let document = delivery.document
        let navigation = navigationEpoch
        let task = Task { @MainActor [weak self] in
            guard !Task.isCancelled, self?.activeDocument == document, self?.navigationEpoch == navigation else { return }
            let result: Result<Any, Error>
            do {
                result = .success(try await call.handler(call.params))
            } catch {
                result = .failure(error)
            }
            guard let self, let work = self.businessWork.removeValue(forKey: id) else { return }
            guard self.activeDocument == document, self.navigationEpoch == navigation,
                  let response = self.wire.finishBusinessCall(call, result: result) else {
                work.reply(nil)
                return
            }
            self.queueReply(response, document: document, send: work.reply)
        }
        businessWork[id] = BusinessWork(task: task, reply: delivery.reply)
    }

    private func queueReply(_ response: String, document: String, send: @escaping (String?) -> Void,
                            acknowledge: (() -> Void)? = nil) {
        let id = deferredReplies.insert(response, document: document, navigation: navigationEpoch, send: send)
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

    private var shim: String {
        let encoder = JSONEncoder()
        guard let originJSON = try? encoder.encode(origin.serialized),
              let handlerJSON = try? encoder.encode(handlerName) else { return "" }
        let allowed = String(decoding: originJSON, as: UTF8.self)
        let handler = String(decoding: handlerJSON, as: UTF8.self)
        return """
        (() => {
          if (location.origin !== \(allowed) || '__OJSB_TRANSPORT__' in window) return;
          const handler = window.webkit?.messageHandlers?.[\(handler)];
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
              const candidate = documentToken;
              const reply = await post([candidate, raw]);
              return candidate === documentToken ? reply : null;
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
