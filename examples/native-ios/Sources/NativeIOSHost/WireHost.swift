import CoreFoundation
import Foundation

/// The reference host manages one active session per WebView document.
final class WireHost {
    final class BusinessCall {
        private let handler: NativeIOSHost.BusinessMethod.StreamingHandler
        private let params: [String: Any]
        let isMedia: Bool
        fileprivate let upload: UploadOperation?
        fileprivate let id: String
        fileprivate let sid: String
        fileprivate let meta: [String: String]
        fileprivate var nextSeq: Int?

        fileprivate init(handler: @escaping NativeIOSHost.BusinessMethod.StreamingHandler, params: [String: Any],
                         isMedia: Bool, id: String, sid: String, meta: [String: String], callbacks: Bool,
                         upload: UploadOperation? = nil) {
            self.handler = handler
            self.params = params
            self.isMedia = isMedia
            self.upload = upload
            self.id = id
            self.sid = sid
            self.meta = meta
            nextSeq = callbacks ? 0 : nil
        }

        @MainActor
        func run(progress: NativeIOSHost.ProgressReporter? = nil) async throws -> Any {
            try await handler(params, progress ?? .init { _ in false })
        }

        func matches(requestID: String) -> Bool {
            id.utf8.elementsEqual(requestID.utf8)
        }
    }

    private enum EventSubscription: Equatable {
        case pending(UUID)
        case subscribed
    }

    static let maxMessageBytes = 1_048_576
    static let maxInflight = 64
    private static let qualifiedName = #"\A(?!rpc\.)[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+"#
    private static let methodPattern = qualifiedName + #"(@[1-9][0-9]*)?\z"#
    private static let baseNamePattern = qualifiedName + #"\z"#
    private static let requestKeys: Set<String> = ["jsonrpc", "method", "id", "params"]
    private static let echo = "conformance.echo"
    private static let subscribe = "bridge.subscribe"
    private static let unsubscribe = "bridge.unsubscribe"
    private static let cancellationMethods: Set<String> = ["bridge.cancel", "bridge.cancel@1"]

    private let platform: String
    private let methods: [String: [String: [Int]]]
    private let businessMethods: [String: NativeIOSHost.BusinessMethod]
    private let events: [String]
    private let businessEvents: Set<String>
    private let networkType: () -> NetworkConnection
    private let media: MediaStore?
    private let uploadEndpoints: [NativeIOSHost.UploadEndpoint]
    private var sessionEndpoints: [NativeIOSHost.UploadEndpoint] = []
    private var activeUpload: UploadOperation?
    var hasUploadEndpoints: Bool { !sessionEndpoints.isEmpty }
    private var subscriptions: [String: EventSubscription] = [:]
    private(set) var sid: String?
    private var callbacksEnabled = false
    private var handshakeIDs = Set<Data>()
    private var requestIDs = Set<Data>()

    init(platform: String, options: NativeIOSHost.Options = .init(),
         businessMethods: [String: NativeIOSHost.BusinessMethod] = [:], businessEvents: [String] = [],
         enableEcho: Bool = true, supportsMedia: Bool = true, supportsAppLifecycle: Bool = true,
         networkType: @escaping () -> NetworkConnection = { .unknown }) {
        self.platform = platform
        self.businessMethods = businessMethods
        self.businessEvents = Set(businessEvents)
        self.networkType = networkType
        let mediaEnabled = options.media && supportsMedia
        media = mediaEnabled ? MediaStore() : nil
        uploadEndpoints = mediaEnabled ? options.uploadEndpoints : []
        var methods = businessMethods.mapValues { _ in ["versions": [1]] }
        if enableEcho { methods[Self.echo] = ["versions": [1]] }
        if options.deviceInfo { methods[DeviceModule.method] = ["versions": [1]] }
        if options.networkStatus { methods[NetworkModule.method] = ["versions": [1]] }
        if options.toast { methods[ToastModule.method] = ["versions": [1]] }
        if mediaEnabled {
            methods[MediaStore.chooseMethod] = ["versions": [1]]
            methods[MediaStore.releaseMethod] = ["versions": [1]]
        }
        self.methods = methods
        let lifecycleEvents = options.appLifecycle && supportsAppLifecycle
            ? AppLifecycleEvent.allCases.map(\.rawValue) : []
        events = businessEvents + (options.networkChanges ? [NetworkModule.event] : []) + lifecycleEvents
    }

    var watchesNetwork: Bool {
        sid != nil && (methods[NetworkModule.method] != nil || subscriptions[NetworkModule.event] == .subscribed)
    }

    var watchesAppLifecycle: Bool {
        sid != nil && AppLifecycleEvent.allCases.contains { subscriptions[$0.rawValue] == .subscribed }
    }

    func reset() {
        activeUpload?.cancel(UploadFailure(-32002, "session_closed"))
        activeUpload = nil
        sessionEndpoints.removeAll()
        media?.reset()
        sid = nil
        callbacksEnabled = false
        subscriptions.removeAll()
        handshakeIDs.removeAll()
        requestIDs.removeAll()
    }

    func cancelUploadForBackground() {
        activeUpload?.cancel(UploadFailure(-32002, "backgrounded"))
    }

    /// Called only after the adapter has authorized the current document.
    /// The adapter runs the after-reply callback once it has sent the acknowledgement.
    func receive(_ raw: String, exceedsInflightLimit: Bool = false,
                 verifiedOrigin: String? = nil, receivedAt: DispatchTime = .now(),
                 isForeground: @escaping () -> Bool = { false },
                 presentToast: (String) -> Bool = { _ in false },
                 chooseMedia: NativeIOSHost.BusinessMethod.Handler? = nil,
                 mediaBusy: Bool = false,
                 onBusinessCall: ((BusinessCall) -> Void)? = nil,
                 onCancelRequest: ((String) -> Void)? = nil,
                 afterReply: (@escaping () -> Void) -> Void = { $0() }) -> String? {
        guard raw.utf8.count <= Self.maxMessageBytes else { return nil }
        let bytes = Data(raw.utf8)
        guard !Self.hasTrailingComma(bytes) else { return parseFailure() }

        let value: Any
        do {
            value = try JSONSerialization.jsonObject(with: bytes, options: [.fragmentsAllowed])
        } catch {
            // Foundation can also fail before exposing the ID of an out-of-range number.
            // Diagnostics are optional; don't label that case a syntax error.
            guard sid != nil, !Self.hasUnrepresentableNumber(bytes) else { return nil }
            return parseFailure()
        }

        let envelope = value as? [String: Any]
        let rpc = envelope?["rpc"] as? [String: Any]
        let meta = envelope?["meta"] as? [String: Any] ?? [:]
        let method = rpc?["method"] as? String
        let id = Self.requestID(rpc?["id"])
        let incomingSID = meta["sid"] as? String
        let hello = method == "bridge.hello" || method == "bridge.hello@1"

        let cancel = method.map(Self.cancellationMethods.contains) ?? false

        if let rpc, rpc["id"] == nil {
            if cancel, let sid, incomingSID == sid,
               envelope?["jsb"] as? String == "1.0",
               rpc["jsonrpc"] as? String == "2.0",
               Set(rpc.keys).isSubset(of: Self.requestKeys),
               Self.validMeta(envelope?["meta"]),
               Self.isPortableJSON(value),
               let params = rpc["params"] as? NSDictionary,
               let requestID = Self.requestID(params["requestId"]),
               params["reason"] == nil || params["reason"] is String {
                onCancelRequest?(requestID)
            }
            return nil
        }
        if let rpc, rpc["method"] == nil { return nil }
        if let incomingSID, !incomingSID.isEmpty, incomingSID != sid { return nil }

        var responseMeta: [String: String] = [:]
        if let sid { responseMeta["sid"] = sid }
        if let trace = meta["traceId"] as? String { responseMeta["traceId"] = trace }

        guard envelope?["jsb"] as? String == "1.0",
              let rpc, rpc["jsonrpc"] as? String == "2.0",
              Set(rpc.keys).isSubset(of: Self.requestKeys),
              let method, method.range(of: Self.methodPattern, options: .regularExpression) != nil,
              let id, !cancel,
              rpc["params"] == nil || rpc["params"] is NSDictionary,
              Self.validMeta(envelope?["meta"]),
              Self.isPortableJSON(value)
        else {
            guard sid != nil || (hello && id != nil && meta["sid"] == nil) else { return nil }
            if let id, !register(id, handshake: hello) { return nil }
            return failure(-32600, "Invalid request", id: id, meta: responseMeta)
        }

        let params = rpc["params"] as? NSDictionary
        let zeroTimeout = meta["timeout"].flatMap(Self.safeInteger) == 0
        if hello {
            guard register(id, handshake: true) else { return nil }
            if exceedsInflightLimit { return failure(-32008, "Rate limited", id: id, meta: responseMeta) }
            if zeroTimeout { return failure(-32602, "Invalid request timeout", id: id, meta: responseMeta) }
            return negotiate(id: id, params: params, responseMeta: responseMeta, verifiedOrigin: verifiedOrigin)
        }

        // Without an established route there is no valid session to attach to an error.
        guard let sid, register(id, handshake: false) else { return nil }
        guard incomingSID == sid else { return failure(-32009, "Session expired", id: id, meta: responseMeta) }
        if exceedsInflightLimit { return failure(-32008, "Rate limited", id: id, meta: responseMeta) }
        let name = method.hasSuffix("@1") ? String(method.dropLast(2)) : method
        let isUpload = name == UploadRequest.method && hasUploadEndpoints
        guard isUpload || methods[name] != nil || name == Self.subscribe || name == Self.unsubscribe else {
            return failure(-32601, "Method not found", id: id, meta: responseMeta)
        }
        if zeroTimeout { return failure(-32602, "Invalid request timeout", id: id, meta: responseMeta) }

        if isUpload, let media {
            let timeout = meta["timeout"].flatMap(Self.safeInteger) ?? Self.defaultTimeoutMs
            return beginUpload(params, media: media, id: id, sid: sid, meta: responseMeta,
                               receivedAt: receivedAt, timeout: timeout,
                               isForeground: isForeground, dispatch: onBusinessCall)
        }

        let isMedia = name == MediaStore.chooseMethod
        let businessMethod = businessMethods[name]
        var handler = businessMethod?.handler
        if isMedia {
            guard Self.validMediaParams(params) else {
                return failure(-32602, "Invalid params", id: id, meta: responseMeta)
            }
            if mediaBusy { return failure(-32010, "Busy", id: id, meta: responseMeta) }
            guard let chooseMedia, onBusinessCall != nil else {
                return mediaFailure(MediaProfileError.unavailable, id: id, meta: responseMeta)
            }
            handler = { params, _ in try await chooseMedia(params) }
        }
        if let handler {
            guard let onBusinessCall else { return failure(-32603, "Internal error", id: id, meta: responseMeta) }
            onBusinessCall(BusinessCall(handler: handler, params: params as? [String: Any] ?? [:],
                                        isMedia: isMedia, id: id, sid: sid, meta: responseMeta,
                                        callbacks: callbacksEnabled && businessMethod?.supportsCallbacks == true))
            return nil
        }

        let result: Any
        var changedEvents = [String]()
        switch name {
        case MediaStore.releaseMethod:
            guard let media else { return mediaFailure(MediaProfileError.unavailable, id: id, meta: responseMeta) }
            guard let ids = Self.mediaReleaseIDs(params) else {
                return failure(-32602, "Invalid params", id: id, meta: responseMeta)
            }
            ids.forEach(media.discard)
            result = NSNull()
        case Self.subscribe, Self.unsubscribe:
            guard let requested = Self.eventNames(params) else {
                return failure(-32602, "Invalid events", id: id, meta: responseMeta)
            }
            if name == Self.subscribe {
                changedEvents = requested.filter(events.contains)
                result = ["subscribed": changedEvents, "denied": requested.filter { !events.contains($0) }]
            } else {
                changedEvents = requested
                result = ["unsubscribed": requested]
            }
        case DeviceModule.method, NetworkModule.method:
            guard params == nil || params?.count == 0 else {
                return failure(-32602, "Invalid params", id: id, meta: responseMeta)
            }
            result = name == DeviceModule.method ? DeviceModule.information() : networkType().payload
        case ToastModule.method:
            guard params?.count == 1, let text = params?["text"] as? String,
                  (1...120).contains(text.unicodeScalars.count) else {
                return failure(-32602, "Invalid params", id: id, meta: responseMeta)
            }
            guard presentToast(text) else {
                return failure(-32603, "Internal error", id: id, meta: responseMeta)
            }
            result = NSDictionary()
        default:
            result = params ?? NSDictionary()
        }

        guard let reply = response(id: id, meta: responseMeta, fields: ["result": result]) else {
            return failure(-32603, "Internal error", id: id, meta: responseMeta)
        }
        if reply.utf8.count > Self.maxMessageBytes {
            // An oversized request trace is unnecessary for correlating this bounded error.
            return failure(-32006, "Payload too large", id: id, meta: ["sid": sid])
        }
        if name == Self.subscribe {
            subscribe(changedEvents, for: sid, afterReply: afterReply)
        } else if name == Self.unsubscribe {
            for event in changedEvents { subscriptions.removeValue(forKey: event) }
        }
        return reply
    }

    private func beginUpload(_ params: NSDictionary?, media: MediaStore, id: String, sid: String,
                             meta: [String: String], receivedAt: DispatchTime, timeout: Int64,
                             isForeground: @escaping () -> Bool, dispatch: ((BusinessCall) -> Void)?) -> String? {
        if let activeUpload, activeUpload.outcome == nil { return failure(-32010, "Busy", id: id, meta: meta) }
        guard let dispatch else { return failure(-32603, "Internal error", id: id, meta: meta) }
        do {
            let request = try UploadRequest.parse(params as? [String: Any] ?? [:], endpoints: sessionEndpoints)
            // Queuing and WebKit's asynchronous document verification consume the same deadline.
            let elapsed = Int64((DispatchTime.now().uptimeNanoseconds - receivedAt.uptimeNanoseconds) / 1_000_000)
            guard elapsed < timeout else { throw UploadFailure(-32001, "timeout") }
            let upload = try UploadOperation(request: request, media: media, timeout: timeout - elapsed,
                                             isForeground: isForeground)
            activeUpload = upload
            dispatch(BusinessCall(handler: { _, progress in try await upload.run(progress: progress) }, params: [:],
                                  isMedia: false, id: id, sid: sid, meta: meta, callbacks: callbacksEnabled, upload: upload))
            return nil
        } catch {
            return uploadFailure(error, id: id, meta: meta)
        }
    }

    private func subscribe(_ names: [String], for sid: String, afterReply: (@escaping () -> Void) -> Void) {
        var awaitingAcknowledgement: [String: UUID] = [:]
        for name in names {
            switch subscriptions[name] {
            case .subscribed:
                continue
            case .pending(let token):
                awaitingAcknowledgement[name] = token
            case nil:
                let token = UUID()
                subscriptions[name] = .pending(token)
                awaitingAcknowledgement[name] = token
            }
        }
        guard !awaitingAcknowledgement.isEmpty else { return }
        afterReply { [weak self] in
            guard let self, self.sid == sid else { return }
            for (name, token) in awaitingAcknowledgement where self.subscriptions[name] == .pending(token) {
                self.subscriptions[name] = .subscribed
            }
        }
    }

    @MainActor
    func sendProgress(for call: BusinessCall, chunk: Any? = nil, deliver: (String) async -> Bool) async -> Bool {
        guard sid == call.sid, call.upload?.outcome == nil, let seq = call.nextSeq,
              seq <= 9_007_199_254_740_991 else { return false }
        var params: [String: Any] = ["requestId": call.id, "seq": seq]
        if let chunk { params["chunk"] = chunk }
        guard JSONSerialization.isValidJSONObject(params), Self.isPortableJSON(params),
              let raw = serialize(rpc: ["jsonrpc": "2.0", "method": "bridge.progress", "params": params],
                                  meta: ["sid": call.sid]), raw.utf8.count <= Self.maxMessageBytes,
              await deliver(raw) else { return false }
        // Completion or cancellation may have closed the stream while WebKit was delivering the frame.
        if call.nextSeq == seq { call.nextSeq = seq + 1 }
        return true
    }

    func finishBusinessCall(_ call: BusinessCall, result: Result<Any, Error>) -> String? {
        call.nextSeq = nil
        guard sid == call.sid else { return nil }
        if let upload = call.upload, activeUpload === upload { activeUpload = nil }
        switch call.upload?.outcome ?? result {
        case .success(let value):
            var insertedID: String?
            let result: Any
            if call.isMedia {
                guard let media, let selection = value as? MediaSelection else {
                    return mediaFailure(MediaProfileError.unavailable, id: call.id, meta: call.meta)
                }
                switch selection {
                case .cancelled:
                    result = ["status": "cancelled", "files": []] as [String: Any]
                case .selected(let image):
                    do {
                        let file = try media.insert(image)
                        insertedID = file["id"] as? String
                        result = ["status": "selected", "files": [file]] as [String: Any]
                    } catch {
                        return mediaFailure(error, id: call.id, meta: call.meta)
                    }
                }
            } else {
                result = value
            }
            guard JSONSerialization.isValidJSONObject([result]), Self.isPortableJSON(result),
                  let reply = response(id: call.id, meta: call.meta, fields: ["result": result]) else {
                if let insertedID { media?.discard(insertedID) }
                if call.isMedia { return mediaFailure(MediaProfileError.unavailable, id: call.id, meta: call.meta) }
                return failure(-32603, "Internal error", id: call.id, meta: call.meta)
            }
            guard reply.utf8.count <= Self.maxMessageBytes else {
                if let insertedID { media?.discard(insertedID) }
                return failure(-32006, "Payload too large", id: call.id, meta: ["sid": call.sid])
            }
            return reply
        case .failure(let error):
            if call.upload != nil { return uploadFailure(error, id: call.id, meta: call.meta) }
            if call.isMedia { return mediaFailure(error, id: call.id, meta: call.meta) }
            if case NativeIOSHost.BusinessMethodError.invalidParams = error {
                return failure(-32602, "Invalid params", id: call.id, meta: call.meta)
            }
            return failure(-32603, "Internal error", id: call.id, meta: call.meta)
        }
    }

    private func uploadFailure(_ error: Error, id: String, meta: [String: String]) -> String? {
        let problem = error as? UploadFailure ?? UploadFailure(-32603, "internal_error")
        return failure(problem.code, "Upload failed", id: id, meta: meta, data: ["reason": problem.reason])
    }

    private func mediaFailure(_ error: Error, id: String, meta: [String: String]) -> String? {
        switch error {
        case is CancellationError:
            return failure(-32002, "Call cancelled", id: id, meta: meta)
        case MediaProfileError.tooLarge:
            return failure(-32006, "Payload too large", id: id, meta: meta)
        case MediaProfileError.busy:
            return failure(-32010, "Busy", id: id, meta: meta)
        default:
            return failure(-32003, "Media unavailable", id: id, meta: meta)
        }
    }

    func cancelBusinessCall(_ call: BusinessCall) -> String? {
        if let upload = call.upload {
            let error = UploadFailure(-32002, "cancelled")
            upload.cancel(error)
            return finishBusinessCall(call, result: .failure(error))
        }
        call.nextSeq = nil
        guard sid == call.sid else { return nil }
        return failure(-32002, "Call cancelled", id: call.id, meta: call.meta)
    }

    func businessEvent(_ name: String, payload: Any, for sid: String) -> String? {
        guard businessEvents.contains(name) else { return nil }
        return event(name, payload: payload, for: sid)
    }

    func networkEvent(_ type: NetworkConnection, for sid: String) -> String? {
        event(NetworkModule.event, payload: type.payload, for: sid)
    }

    func appLifecycleEvent(_ transition: AppLifecycleEvent, for sid: String) -> String? {
        event(transition.rawValue, payload: NSNull(), for: sid)
    }

    private func event(_ name: String, payload: Any, for sid: String) -> String? {
        guard self.sid == sid, subscriptions[name] == .subscribed,
              JSONSerialization.isValidJSONObject([payload]), Self.isPortableJSON(payload),
              let raw = serialize(rpc: [
                "jsonrpc": "2.0",
                "method": "bridge.event",
                "params": ["name": name, "payload": payload]
              ], meta: ["sid": sid]), raw.utf8.count <= Self.maxMessageBytes else { return nil }
        return raw
    }

    static func isQualifiedBaseName(_ name: String) -> Bool {
        name.range(of: baseNamePattern, options: .regularExpression) != nil
    }

    private static func eventNames(_ params: NSDictionary?) -> [String]? {
        guard let events = params?["events"] as? [String], !events.isEmpty, Set(events).count == events.count,
              events.allSatisfy(isQualifiedBaseName) else { return nil }
        return events
    }

    private static func validMediaParams(_ params: NSDictionary?) -> Bool {
        guard let params else { return true }
        return params.allKeys.allSatisfy { key in
            switch key as? String {
            case "mediaType": return params[key] as? [String] == ["image"]
            case "sourceType": return params[key] as? [String] == ["album"]
            case "count": return params[key].flatMap(safeInteger) == 1
            default: return false
            }
        }
    }

    private static func mediaReleaseIDs(_ params: NSDictionary?) -> [String]? {
        guard params?.count == 1, let ids = params?["ids"] as? [String], (1...32).contains(ids.count),
              ids.allSatisfy({ $0.range(of: #"\A[0-9a-f]{32}\z"#, options: .regularExpression) != nil }) else {
            return nil
        }
        return ids
    }

    private func parseFailure() -> String? {
        guard let sid else { return nil }
        return failure(-32700, "Parse error", id: nil, meta: ["sid": sid])
    }

    private static func containsUnquotedByte(in bytes: Data, where predicate: (Int) -> Bool) -> Bool {
        var quoted = false
        var escaped = false
        for (index, byte) in bytes.enumerated() {
            if quoted {
                if escaped { escaped = false }
                else if byte == 0x5c { escaped = true }
                else if byte == 0x22 { quoted = false }
            } else if byte == 0x22 {
                quoted = true
            } else if predicate(index) {
                return true
            }
        }
        return false
    }

    private static func isJSONWhitespace(_ byte: UInt8) -> Bool {
        byte == 0x20 || byte == 0x09 || byte == 0x0a || byte == 0x0d
    }

    private static func hasTrailingComma(_ bytes: Data) -> Bool {
        // Foundation accepts trailing commas, unlike the JSON grammar.
        containsUnquotedByte(in: bytes) { index in
            guard bytes[index] == 0x2c else { return false }
            var next = index + 1
            while next < bytes.count && isJSONWhitespace(bytes[next]) { next += 1 }
            return next < bytes.count && (bytes[next] == 0x7d || bytes[next] == 0x5d)
        }
    }

    private static func isNumberByte(_ byte: UInt8) -> Bool {
        switch byte {
        case 0x30...0x39, 0x2b, 0x2d, 0x2e, 0x45, 0x65: return true
        default: return false
        }
    }

    private static func hasUnrepresentableNumber(_ bytes: Data) -> Bool {
        // Only called after a parse failure. An unrepresentable or ambiguous numeric
        // token is enough to withhold the optional diagnostic; no token is repaired.
        var numberEnd = 0
        return containsUnquotedByte(in: bytes) { start in
            guard start >= numberEnd, bytes[start] == 0x2d || (0x30...0x39).contains(bytes[start]) else {
                return false
            }
            var end = start + 1
            while end < bytes.count && isNumberByte(bytes[end]) { end += 1 }
            numberEnd = end
            return Double(String(decoding: bytes[start..<end], as: UTF8.self))?.isFinite != true
        }
    }

    private func register(_ id: String, handshake: Bool) -> Bool {
        let key = Data(id.utf8)
        if handshake { return handshakeIDs.insert(key).inserted }
        return requestIDs.insert(key).inserted
    }

    private static let defaultTimeoutMs: Int64 = 15_000

    private func negotiate(id: String, params: NSDictionary?, responseMeta: [String: String],
                           verifiedOrigin: String?) -> String? {
        guard let protocols = params?["protocols"] as? [Any], !protocols.isEmpty,
              Self.validHelloOptionalFields(params)
        else {
            return failure(-32602, "Invalid handshake params", id: id, meta: responseMeta)
        }
        var majors = Set<Int64>()
        for item in protocols {
            guard let major = Self.safeInteger(item), major > 0, majors.insert(major).inserted else {
                return failure(-32602, "Invalid handshake params", id: id, meta: responseMeta)
            }
        }
        guard majors.contains(1) else {
            return failure(-32004, "Unsupported protocol", id: id, meta: responseMeta, data: ["supported": [1]])
        }

        let wants = params?["wants"] as? [String] ?? []
        let endpoints: [NativeIOSHost.UploadEndpoint]
        if self.sid == nil {
            let grants = uploadEndpoints.filter { $0.origin == verifiedOrigin }
            // Two policies for the same destination are ambiguous. Omit that destination.
            endpoints = Dictionary(grouping: grants, by: { $0.url.absoluteString }).values.compactMap {
                $0.count == 1 ? $0.first : nil
            }
        } else {
            endpoints = sessionEndpoints
        }
        var advertisedMethods = methods
        if !endpoints.isEmpty { advertisedMethods[UploadRequest.method] = ["versions": [1]] }
        let callbacks = self.sid == nil
            ? wants.contains("callbacks") && (!endpoints.isEmpty || businessMethods.values.contains(where: \.supportsCallbacks))
            : callbacksEnabled
        var features = media != nil || !businessMethods.isEmpty ? ["cancel"] : []
        if callbacks { features.append("callbacks") }
        let sid = self.sid ?? UUID().uuidString.lowercased()
        let result: [String: Any] = [
            "jsb": "1.0",
            "sid": sid,
            "host": ["platform": platform, "name": "ios-wk", "version": "0.2.0"],
            "capabilities": [
                "methods": advertisedMethods,
                "events": events,
                "features": features
            ],
            "limits": ["maxMessageBytes": Self.maxMessageBytes, "maxInflight": Self.maxInflight, "defaultTimeoutMs": Self.defaultTimeoutMs]
        ]
        var meta = responseMeta
        meta["sid"] = sid
        var reply = response(id: id, meta: meta, fields: ["result": result])
        if meta["traceId"] != nil, reply.map({ $0.utf8.count > Self.maxMessageBytes }) == true {
            reply = response(id: id, meta: ["sid": sid], fields: ["result": result])
        }
        guard let reply, reply.utf8.count <= Self.maxMessageBytes else {
            return failure(-32006, "Payload too large", id: id, meta: responseMeta)
        }
        self.sid = sid
        sessionEndpoints = endpoints
        callbacksEnabled = callbacks
        return reply
    }

    private func failure(_ code: Int, _ message: String, id: String?, meta: [String: String], data: [String: Any]? = nil) -> String? {
        var error: [String: Any] = ["code": code, "message": message]
        if let data { error["data"] = data }
        if let reply = response(id: id, meta: meta, fields: ["error": error]),
           reply.utf8.count <= Self.maxMessageBytes { return reply }
        return response(id: id, meta: meta.filter { $0.key == "sid" }, fields: ["error": error])
    }

    private func response(id: String?, meta: [String: String], fields: [String: Any]) -> String? {
        var rpc = fields
        rpc["jsonrpc"] = "2.0"
        rpc["id"] = id as Any? ?? NSNull()
        return serialize(rpc: rpc, meta: meta)
    }

    private func serialize(rpc: [String: Any], meta: [String: String]) -> String? {
        var envelope: [String: Any] = ["jsb": "1.0", "rpc": rpc]
        if !meta.isEmpty { envelope["meta"] = meta }
        guard let data = try? JSONSerialization.data(withJSONObject: envelope, options: [.withoutEscapingSlashes]) else {
            return nil
        }
        return String(decoding: data, as: UTF8.self)
    }

    private static func requestID(_ value: Any?) -> String? {
        guard let id = value as? String, (1...128).contains(id.unicodeScalars.count) else { return nil }
        return id
    }

    private static func validMeta(_ value: Any?) -> Bool {
        guard let value else { return true }
        guard let meta = value as? [String: Any] else { return false }
        if let sid = meta["sid"], (sid as? String)?.isEmpty != false { return false }
        if let trace = meta["traceId"], !(trace is String) { return false }
        for key in ["timeout", "ts"] {
            if let number = meta[key], (safeInteger(number) ?? -1) < 0 { return false }
        }
        return true
    }

    private static func validHelloOptionalFields(_ params: NSDictionary?) -> Bool {
        if let value = params?["sdk"] {
            guard let sdk = value as? [String: Any], sdk["name"] is String, sdk["version"] is String else { return false }
        }
        if let value = params?["wants"] {
            guard let wants = value as? [String], Set(wants.map { Data($0.utf8) }).count == wants.count else { return false }
        }
        return true
    }

    private static func safeInteger(_ value: Any) -> Int64? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard abs(double) <= 9_007_199_254_740_991, double.rounded(.towardZero) == double else { return nil }
        return Int64(double)
    }

    private static func isPortableJSON(_ value: Any) -> Bool {
        if let object = value as? NSDictionary { return object.allValues.allSatisfy(isPortableJSON) }
        if let array = value as? [Any] { return array.allSatisfy(isPortableJSON) }
        if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            let value = number.doubleValue
            return value.isFinite && (value.rounded(.towardZero) != value || abs(value) <= 9_007_199_254_740_991)
        }
        return true
    }
}
