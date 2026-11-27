import Network
import ObjectiveC
import WebKit

/// Hosts the native bridge in an app-owned WebView or the standalone Debug demo.
public enum NativeIOSHost {
    public struct Options {
        public let deviceInfo: Bool
        public let networkStatus: Bool
        public let networkChanges: Bool
        public let toast: Bool
        public let media: Bool
        public let appLifecycle: Bool
        public let uploadEndpoints: [UploadEndpoint]

        public init(deviceInfo: Bool = false, networkStatus: Bool = false, networkChanges: Bool = false,
                    toast: Bool = false, media: Bool = false, appLifecycle: Bool = false,
                    uploadEndpoints: [UploadEndpoint] = []) {
            self.deviceInfo = deviceInfo
            self.networkStatus = networkStatus
            self.networkChanges = networkChanges
            self.toast = toast
            self.media = media
            self.appLifecycle = appLifecycle
            self.uploadEndpoints = uploadEndpoints
        }
    }

    /// Schedules a response completion. Completion returns true when it sends the protocol frame.
    typealias ReplyScheduler = @MainActor (String, @escaping @MainActor () -> Bool) -> Void

    public enum AttachmentError: Error, Equatable {
        case invalidOrigin
        case webViewAlreadyLoaded
        case alreadyAttached
    }

    public enum BusinessEventError: Error, Equatable {
        case invalidName(String)
        case duplicateName(String)
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

        /// Queues a JSON event for the current verified document after its subscription is acknowledged.
        /// A successful return indicates that the event was handed to the document route.
        @discardableResult
        public func emit(_ name: String, payload: Any) -> Bool {
            host?.emit(name, payload: payload) ?? false
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

    /// Installs the bridge for one exact HTTPS origin.
    @MainActor
    public static func attach(to webView: WKWebView, allowing originURL: URL,
                              options: Options = .init(), methods: [BusinessMethod] = [],
                              events: [String] = []) throws -> Attachment {
        try attach(to: webView, allowing: [originURL], options: options, methods: methods, events: events)
    }

    /// Installs the bridge for a nonempty list of exact HTTPS origins before the first navigation.
    /// Retain the attachment and forward lifecycle callbacks from the app's navigation delegate.
    @MainActor
    public static func attach(to webView: WKWebView, allowing originURLs: [URL],
                              options: Options = .init(), methods: [BusinessMethod] = [],
                              events: [String] = []) throws -> Attachment {
        let origins = originURLs.compactMap { AllowedOrigin($0) }
        guard !origins.isEmpty, origins.count == originURLs.count else { throw AttachmentError.invalidOrigin }
        let controller = webView.configuration.userContentController
        let previous = attachments.object(forKey: controller)
        guard previous?.webView == nil else { throw AttachmentError.alreadyAttached }
        guard webView.url == nil, !webView.isLoading, webView.backForwardList.currentItem == nil else {
            throw AttachmentError.webViewAlreadyLoaded
        }

        var handlers: [String: BusinessMethod] = [:]
        for method in methods {
            guard handlers.updateValue(method, forKey: method.name) == nil else {
                throw BusinessMethodError.duplicateName(method.name)
            }
        }
        var eventNames = Set<String>()
        for event in events {
            guard BusinessMethod.isAllowedName(event) else { throw BusinessEventError.invalidName(event) }
            guard eventNames.insert(event).inserted else { throw BusinessEventError.duplicateName(event) }
        }
        if let previous { detach(previous, from: controller) }

        let handlerName = "ojsb_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let host = WebKitHost(origins: origins, options: options, businessMethods: handlers, businessEvents: events,
                              enableEcho: false, handlerName: handlerName, watchNetwork: nil) { _, complete in
            _ = complete()
        }
        host.bind(to: webView)
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
        host.unbind()
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
            let adapter = WebKitHost(origins: [origin], options: options, businessMethods: [:],
                                     enableEcho: true, handlerName: "ojsb", watchNetwork: watchNetwork,
                                     scheduleReply: scheduleReply)
            let controller = configuration.userContentController
            adapter.install(in: controller)
            let webView = WKWebView(frame: .zero, configuration: configuration)
            adapter.bind(to: webView)
            webView.navigationDelegate = adapter
            attachments.setObject(adapter, forKey: controller)
            return webView
        }
        #endif
        return WKWebView(frame: .zero, configuration: configuration)
    }
}

struct AllowedOrigin {
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
    /// The view owns this token even when the app retains its Attachment or user content controller.
    private final class ViewLifetime {
        var host: WebKitHost?

        init(_ host: WebKitHost) { self.host = host }

        deinit {
            guard let host else { return }
            Task { @MainActor in host.webContentProcessDidTerminate() }
        }
    }

    private static var lifetimeKey: UInt8 = 0
    private struct Delivery {
        let document: String
        let origin: String
        let raw: String
        let receivedAt: DispatchTime
        let exceedsBacklogLimit: Bool
        let reply: (String?) -> Void
    }

    private struct BusinessWork {
        let call: WireHost.BusinessCall
        let progress: NativeIOSHost.ProgressReporter
        let task: Task<Void, Never>
        let reply: (String?) -> Void
    }

    private let origins: [AllowedOrigin]
    private let handlerName: String
    private let scheduleReply: NativeIOSHost.ReplyScheduler
    private let wire: WireHost
    private let network: NetworkModule?
    private let appLifecycle: AppLifecycleModule?
    private let toast: ToastModule?
    private let mediaPicker: MediaPicker?
    private var activeDocument: String?
    private var activeOrigin: String?
    private var pending: [Delivery] = []
    private var businessWork: [UUID: BusinessWork] = [:]
    private let deferredReplies = DeferredReplies()
    private var validating = false
    private var validationEpoch = 0
    private var navigationEpoch = 0
    private var userScript: WKUserScript?
    private(set) weak var webView: WKWebView?

    func bind(to webView: WKWebView) {
        self.webView = webView
        objc_setAssociatedObject(webView, &Self.lifetimeKey, ViewLifetime(self), .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    }

    func unbind() {
        if let webView {
            let lifetime = objc_getAssociatedObject(webView, &Self.lifetimeKey) as? ViewLifetime
            lifetime?.host = nil
            objc_setAssociatedObject(webView, &Self.lifetimeKey, nil, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        }
        webView = nil
        webContentProcessDidTerminate()
    }

    init(origins: [AllowedOrigin], options: NativeIOSHost.Options,
         businessMethods: [String: NativeIOSHost.BusinessMethod], businessEvents: [String] = [],
         enableEcho: Bool, handlerName: String,
         watchNetwork: NetworkModule.Watch?,
         scheduleReply: @escaping NativeIOSHost.ReplyScheduler) {
        self.origins = origins
        self.handlerName = handlerName
        self.scheduleReply = scheduleReply
        let network = options.networkStatus || options.networkChanges
            ? NetworkModule(watch: watchNetwork ?? NetworkModule.watchSystemPath) : nil
        self.network = network
        toast = options.toast ? ToastModule() : nil
        #if os(iOS)
        appLifecycle = options.appLifecycle || (options.media && !options.uploadEndpoints.isEmpty) ? AppLifecycleModule() : nil
        mediaPicker = options.media ? MediaPicker() : nil
        #else
        appLifecycle = nil
        mediaPicker = nil
        #endif
        wire = WireHost(platform: "ios", options: options, businessMethods: businessMethods,
                        businessEvents: businessEvents, enableEcho: enableEcho,
                        supportsMedia: mediaPicker != nil, supportsAppLifecycle: appLifecycle != nil,
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
        let backlog = pending.count + deferredReplies.count
        let outstanding = backlog + businessWork.count
        guard let webView, message.webView === webView, message.name == handlerName,
              message.frameInfo.isMainFrame,
              let origin = origins.first(where: { $0.matches(message.frameInfo.securityOrigin) }),
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

        // Bound the transport backlog independently of active business work.
        pending.append(Delivery(document: body[0], origin: origin.serialized, raw: body[1], receivedAt: .now(),
                                exceedsBacklogLimit: backlog >= WireHost.maxInflight,
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
        activeOrigin = nil
        wire.reset()
        network?.stop()
        appLifecycle?.stop()
        toast?.dismiss()
        mediaPicker?.cancel()
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
            arguments: ["allowed": delivery.origin, "candidate": delivery.document], in: nil, in: .page
        ) { [weak self] result in
            guard let self, validation == self.validationEpoch else { return }
            self.validating = false
            if navigation == self.navigationEpoch {
                self.pending.removeFirst()
                if (try? result.get()) as? Bool == true {
                    if self.activeDocument != delivery.document || self.activeOrigin != delivery.origin {
                        self.resetDocument()
                        self.activeDocument = delivery.document
                        self.activeOrigin = delivery.origin
                    }
                    var acknowledge: (() -> Void)?
                    var businessCall: WireHost.BusinessCall?
                    // Earlier verified cancellations can release work before this request is admitted.
                    let exceedsInflightLimit = delivery.exceedsBacklogLimit || self.businessWork.count >= WireHost.maxInflight
                    if let response = self.wire.receive(delivery.raw, exceedsInflightLimit: exceedsInflightLimit,
                                                        verifiedOrigin: delivery.origin, receivedAt: delivery.receivedAt,
                                                        isForeground: { [weak webView] in webView != nil && AppLifecycleModule.isForeground },
                                                        presentToast: { self.toast?.show($0, in: webView) ?? false },
                                                        chooseMedia: { [weak self] _ in
                                                            guard let picker = self?.mediaPicker, let webView = self?.webView else {
                                                                throw MediaProfileError.unavailable
                                                            }
                                                            return try await picker.choose(in: webView)
                                                        },
                                                        mediaBusy: self.businessWork.values.contains { $0.call.isMedia },
                                                        onBusinessCall: { businessCall = $0 },
                                                        onCancelRequest: { self.cancel($0, document: delivery.document) },
                                                        afterReply: { acknowledge = $0 }) {
                        self.updateEventObservation()
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
        let progress = NativeIOSHost.ProgressReporter { [weak self] chunk in
            guard let self, let work = self.businessWork[id], self.navigationEpoch == navigation,
                  self.activeDocument == document, let origin = self.activeOrigin, let webView = self.webView
            else { return false }
            return await self.wire.sendProgress(for: work.call, chunk: chunk) { raw in
                // A progress frame must reach the receiver before the original WithReply is completed.
                return await withCheckedContinuation { receipt in
                    webView.callAsyncJavaScript(
                        """
                        return window.location.origin === allowed &&
                          window.__OJSB_DELIVER__?.(candidate, raw, true) === true;
                        """,
                        arguments: ["allowed": origin, "candidate": document, "raw": raw], in: nil, in: .page
                    ) { result in
                        receipt.resume(returning: (try? result.get()) as? Bool == true)
                    }
                }
            }
        }
        let task = Task { @MainActor [weak self] in
            guard !Task.isCancelled, self?.activeDocument == document, self?.navigationEpoch == navigation else { return }
            let result: Result<Any, Error>
            do {
                result = .success(try await call.run(progress: progress))
            } catch {
                result = .failure(error)
            }
            guard let self, let work = self.businessWork.removeValue(forKey: id) else { return }
            guard self.activeDocument == document, self.navigationEpoch == navigation,
                  let response = self.wire.finishBusinessCall(call, result: result) else {
                work.reply(nil)
                return
            }
            self.queueReply(response, document: document, send: work.reply, progress: work.progress)
        }
        businessWork[id] = BusinessWork(call: call, progress: progress, task: task, reply: delivery.reply)
    }

    private func cancel(_ requestID: String, document: String) {
        guard let id = businessWork.first(where: { $0.value.call.matches(requestID: requestID) })?.key,
              let work = businessWork.removeValue(forKey: id) else { return }
        // Removing the task gives cancellation sole ownership of the original WithReply.
        work.task.cancel()
        if work.call.isMedia { mediaPicker?.cancel() }
        guard let response = wire.cancelBusinessCall(work.call) else {
            work.reply(nil)
            return
        }
        queueReply(response, document: document, send: work.reply, progress: work.progress)
    }

    private func queueReply(_ response: String, document: String, send: @escaping (String?) -> Void,
                            acknowledge: (() -> Void)? = nil, progress: NativeIOSHost.ProgressReporter? = nil) {
        let id = deferredReplies.insert(response, document: document, navigation: navigationEpoch, send: send)
        let schedule: () -> Void = { [weak self] in
            self?.scheduleReply(response) { [weak self] in
                guard let self, self.deferredReplies.complete(id, document: self.activeDocument, navigation: self.navigationEpoch)
                else { return false }
                if let acknowledge {
                    acknowledge()
                    self.updateEventObservation()
                }
                return true
            }
        }
        if let progress { progress.whenDrained(schedule) } else { schedule() }
    }

    private func updateEventObservation() {
        guard let sid = wire.sid, let document = activeDocument else {
            network?.stop()
            appLifecycle?.stop()
            return
        }
        if wire.watchesNetwork {
            network?.start { [weak self] type in
                guard let self, let raw = self.wire.networkEvent(type, for: sid) else { return }
                self.deliverEvent(raw, to: document)
            }
        } else {
            network?.stop()
        }
        if wire.watchesAppLifecycle || wire.hasUploadEndpoints {
            appLifecycle?.start { [weak self] event in
                guard let self else { return }
                if event == .backgrounded { self.wire.cancelUploadForBackground() }
                guard let raw = self.wire.appLifecycleEvent(event, for: sid) else { return }
                self.deliverEvent(raw, to: document)
            }
        } else {
            appLifecycle?.stop()
        }
    }

    func emit(_ name: String, payload: Any) -> Bool {
        guard let document = activeDocument, let sid = wire.sid,
              let raw = wire.businessEvent(name, payload: payload, for: sid) else { return false }
        return deliverEvent(raw, to: document)
    }

    @discardableResult
    private func deliverEvent(_ raw: String, to document: String) -> Bool {
        guard activeDocument == document, let activeOrigin, let webView else { return false }
        // Keep identity validation and delivery in the same WebKit evaluation.
        webView.callAsyncJavaScript(
            "return window.location.origin === allowed && window.__OJSB_DELIVER__?.(candidate, raw) === true;",
            arguments: ["allowed": activeOrigin, "candidate": document, "raw": raw], in: nil, in: .page
        )
        return true
    }

    private var shim: String {
        let encoder = JSONEncoder()
        guard let originsJSON = try? encoder.encode(origins.map(\.serialized)),
              let handlerJSON = try? encoder.encode(handlerName) else { return "" }
        let allowed = String(decoding: originsJSON, as: UTF8.self)
        let handler = String(decoding: handlerJSON, as: UTF8.self)
        return """
        (() => {
          if (!\(allowed).includes(location.origin) || '__OJSB_TRANSPORT__' in window) return;
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
          // Once the receiver has seen a frame, its exception must not make native reuse the sequence.
          const dispatch = raw => {
            try { receive(raw); }
            catch (error) { queueMicrotask(() => { throw error; }); }
          };
          Object.defineProperty(window, '__OJSB_RECEIVE__', {
            get: () => receive,
            set(callback) {
              receive = typeof callback === 'function' ? callback : undefined;
              while (receive && pending.length) dispatch(pending.shift());
            }
          });
          Object.defineProperty(window, '__OJSB_DELIVER__', {
            value(candidate, raw, requireReceiver = false) {
              if (candidate !== documentToken) return false;
              if (receive) dispatch(raw);
              else if (requireReceiver) return false;
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
