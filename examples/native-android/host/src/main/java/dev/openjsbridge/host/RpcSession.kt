package dev.openjsbridge.host

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParseException
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.IOException
import java.io.StringReader
import java.util.UUID
import kotlin.math.abs

/** Wire state for one confirmed document. Used on the WebView thread. */
internal class RpcSession(
    enableEcho: Boolean,
    modules: BridgeModules = BridgeModules(),
    businessMethods: List<BusinessMethod> = emptyList(),
    supportsCancellation: Boolean = false,
    private val businessEvents: Set<String> = emptySet(),
    origin: String? = null,
) {
    internal class ProgressRoute : BusinessProgress {
        var post: ((JsonElement?) -> Boolean)? = null
        override suspend fun send(chunk: JsonElement?): Boolean = post?.invoke(chunk) ?: false
    }

    internal class BusinessCall(
        private val execute: suspend (JsonObject, BusinessProgress) -> JsonElement,
        val params: JsonObject,
        val id: String,
        val sid: String,
        val supportsProgress: Boolean = false,
        val onCancel: (() -> Unit)? = null,
        val mediaSelection: Boolean = false,
        val upload: TransferUploadTask? = null,
    ) {
        val progress = ProgressRoute()

        suspend fun handler(
            params: JsonObject = this.params,
            progress: BusinessProgress = this.progress,
        ): JsonElement = execute(params, progress)
    }

    private class EventSubscription {
        var acknowledged = false
        var stop: (() -> Unit)? = null
    }

    private class InvalidNativeParamsException(message: String) : RuntimeException(message)

    private var sid: String? = null
    private val helloIds = HashSet<String>()
    private val requestIds = HashSet<String>()
    private val media = modules.media?.takeIf { supportsCancellation }?.newSession()
    private val upload = modules.upload?.takeIf { media != null }
    private val uploadOrigin = origin?.takeIf { upload?.allows(it) == true }
    private val methods = buildMap<String, (JsonObject?) -> JsonElement> {
        if (enableEcho) put(ECHO) { params -> params ?: JsonObject() }
        modules.device?.let { device -> put(DEVICE_INFO, query(device::info)) }
        modules.network?.let { network -> put(NETWORK_STATUS, query { network.status().snapshot() }) }
        media?.let { session ->
            put(MEDIA_RELEASE) { params ->
                session.release(releaseIds(params))
                JsonNull.INSTANCE
            }
        }
        modules.toast?.let { toast ->
            put(TOAST_SHOW) { params ->
                val text = params?.get("text").asStringOrNull()
                if (params?.size() != 1 || text == null || text.codePointCount(0, text.length) !in 1..120) {
                    throw InvalidNativeParamsException("Invalid params")
                }
                toast.show(text)
                JsonObject()
            }
        }
    }
    private val businessMethods = businessMethods.indexBusinessMethods()
    private val canCancel = supportsCancellation && (this.businessMethods.isNotEmpty() || media != null)
    private val canReportProgress = uploadOrigin != null ||
        (supportsCancellation && this.businessMethods.values.any { it.supportsProgress })
    private var callbacksNegotiated = false
    val maxMessageBytes = MAX_MESSAGE_BYTES
    private val observedEvents = buildMap<String, ((JsonElement) -> Unit) -> (() -> Unit)?> {
        modules.networkEvents?.let { source ->
            put(NETWORK_STATUS_CHANGED) { emit -> source.observe { emit(it.snapshot()) } }
        }
        modules.appLifecycle?.let { source ->
            for (event in AppLifecycleEvent.entries) {
                put(event.wireName) { emit -> source.observe { if (it == event) emit(JsonNull.INSTANCE) } }
            }
        }
    }
    private val enabledEvents = businessEvents + observedEvents.keys
    private var eventReceiver: ((String) -> Boolean)? = null
    private val subscriptions = mutableMapOf<String, EventSubscription>()

    fun confirmEventReceiver(post: (String) -> Boolean) {
        if (enabledEvents.isNotEmpty()) eventReceiver = post
    }

    fun emit(name: String, payload: JsonElement): Boolean = name in businessEvents && emitEvent(name, payload)

    private fun availableEvents(): Set<String> = if (eventReceiver == null) emptySet() else enabledEvents

    private fun emitEvent(name: String, payload: JsonElement): Boolean {
        val activeSid = sid ?: return false
        val post = eventReceiver ?: return false
        val subscription = subscriptions[name]?.takeIf { it.acknowledged } ?: return false
        val raw = checkedNotification(activeSid, "bridge.event", JsonObject().apply {
            addProperty("name", name)
            add("payload", payload)
        }) ?: return false
        return subscriptions[name] === subscription && post(raw)
    }

    fun close() {
        sid = null
        callbacksNegotiated = false
        eventReceiver = null
        try {
            media?.close()
        } finally {
            for (name in subscriptions.keys.toList()) unsubscribe(name)
        }
    }

    fun receive(
        raw: String,
        businessBusy: Boolean = false,
        onBusinessCall: ((BusinessCall) -> Unit)? = null,
        onCancellation: ((String) -> Unit)? = null,
        mediaBusy: Boolean = false,
        uploadBusy: Boolean = false,
        receivedAtMillis: Long? = null,
        afterResponse: (() -> Unit) -> Unit = {},
    ): String? {
        if (exceedsMessageLimit(raw)) return null
        val envelope = parseObject(raw) ?: return null
        val rpc = envelope.get("rpc") as? JsonObject ?: return null

        if (!rpc.has("id")) {
            if (onCancellation != null) cancellationRequestId(envelope, rpc)?.let(onCancellation)
            return null
        }
        val id = rpc.get("id").asStringOrNull() ?: return null
        if (id.codePointCount(0, id.length) !in 1..128 || !rpc.has("method") ||
            rpc.has("result") || rpc.has("error")
        ) return null

        val method = rpc.get("method").asStringOrNull()
        val hello = method == HELLO || method == "$HELLO@1"
        val meta = envelope.get("meta") as? JsonObject
        val incomingSid = meta?.get("sid").asStringOrNull()
        val activeSid = sid
        // A stale SID gives us no safe response correlation. Before hello, only
        // the handshake may reply without meta.sid.
        if (incomingSid != null && incomingSid != activeSid) return null
        if (!hello && activeSid == null) return null

        val seen = if (hello) helloIds else requestIds
        val replySid = if (hello) null else activeSid
        if (id in seen) return null
        if (seen.size >= MAX_RECORDED_IDS) return failure(id, replySid, -32008, "Request limit reached")
        seen.add(id)
        val rawParams = rpc.get("params")
        val params = rawParams as? JsonObject
        val versionOne = method?.removeSuffix("@1").orEmpty()
        val business = businessMethods[versionOne]
        val activeMedia = media?.takeIf { versionOne == MEDIA_CHOOSE }
        val activeUpload = upload?.takeIf { versionOne == UPLOAD }
        val invalidMeta = when {
            !envelope.has("meta") -> false
            meta == null -> true
            else -> !validMeta(meta)
        }
        if (envelope.get("jsb").asStringOrNull() != "1.0" ||
            rpc.get("jsonrpc").asStringOrNull() != "2.0" ||
            method == null || !validMethod(method) ||
            !rpc.keySet().all { it in REQUEST_KEYS } ||
            (rawParams != null && params == null) || invalidMeta ||
            !validJsonNumbers(envelope) || method in NOTIFICATION_ONLY
        ) return failure(id, replySid, -32600, "Invalid request")

        if (!hello && incomingSid == null) return failure(id, activeSid, -32009, "Session expired")
        if (activeUpload != null && uploadOrigin == null) return uploadFailure(id, replySid, -32003, "endpoint_not_allowed")
        if (activeMedia != null && mediaBusy) return failure(id, replySid, -32010, "Busy")
        if (activeUpload != null && uploadBusy) return uploadFailure(id, replySid, -32010, "busy")
        val releaseDuringUpload = uploadBusy && uploadOrigin != null && versionOne == MEDIA_RELEASE
        if (businessBusy && !releaseDuringUpload) return failure(id, replySid, -32008, "Rate limited")
        val handler = methods[versionOne]
        val control = versionOne == SUBSCRIBE || versionOne == UNSUBSCRIBE
        val timeout = meta?.get("timeout").asSafeIntegerOrNull()
        if ((hello || handler != null || control || business != null || activeMedia != null || activeUpload != null) &&
            timeout == 0L
        ) {
            if (activeUpload != null) return uploadFailure(id, replySid, -32602, "invalid_params")
            return failure(id, replySid, -32602, "Invalid request timeout")
        }

        if (hello) return negotiate(id, params)
        val requestSid = activeSid ?: return null
        if (activeMedia != null) {
            return chooseMedia(activeMedia, params ?: JsonObject(), id, requestSid, onBusinessCall)
        }
        if (activeUpload != null) {
            if (onBusinessCall == null) return uploadFailure(id, requestSid, -32603, "internal_error")
            if (hasRepeatedUploadHeader(raw, params)) return uploadFailure(id, requestSid, -32602, "invalid_params")
            val task = try {
                activeUpload.open(checkNotNull(uploadOrigin), checkNotNull(media), params,
                    timeout ?: DEFAULT_TIMEOUT_MS, receivedAtMillis)
            } catch (error: MediaFailure) {
                return uploadFailure(id, requestSid, error.code, error.message)
            } catch (_: RuntimeException) {
                return uploadFailure(id, requestSid, -32603, "internal_error")
            }
            onBusinessCall(BusinessCall({ _, progress -> task.run(progress) }, JsonObject(), id, requestSid,
                supportsProgress = true, upload = task))
            return null
        }
        if (control) {
            val events = eventNames(params) ?: return failure(id, requestSid, -32602, "Invalid event names")
            return updateSubscriptions(id, versionOne, requestSid, events, afterResponse)
        }
        if (handler != null) {
            val value = try {
                handler(params)
            } catch (error: InvalidNativeParamsException) {
                return failure(id, requestSid, -32602, checkNotNull(error.message))
            } catch (_: RuntimeException) {
                return failure(id, requestSid, -32603, "Internal error")
            }
            val result = success(id, requestSid, value)
            if (exceedsMessageLimit(result)) return failure(id, requestSid, -32006, "Payload too large")
            return result
        }
        if (business != null) {
            if (onBusinessCall == null) return failure(id, requestSid, -32603, "Internal error")
            onBusinessCall(BusinessCall(business.execute, params ?: JsonObject(), id, requestSid, business.supportsProgress))
            return null
        }
        return failure(id, requestSid, -32601, "Method not found")
    }

    private fun chooseMedia(
        media: MediaSession,
        params: JsonObject,
        id: String,
        sid: String,
        startCall: ((BusinessCall) -> Unit)?,
    ): String? {
        if (!params.keySet().all { it in CHOOSE_KEYS } ||
            (params.has("mediaType") && !params.get("mediaType").isSingleChoice("image")) ||
            (params.has("sourceType") && !params.get("sourceType").isSingleChoice("album")) ||
            (params.has("count") && params.get("count").asSafeIntegerOrNull() != 1L)
        ) return failure(id, sid, -32602, "Invalid params")
        if (startCall == null) return failure(id, sid, -32603, "Internal error")
        startCall(BusinessCall({ _, _ -> media.choose() }, params, id, sid,
            onCancel = media::abortCopy, mediaSelection = true))
        return null
    }

    private fun cancellationRequestId(envelope: JsonObject, rpc: JsonObject): String? {
        if (!canCancel || rpc.get("method").asStringOrNull() !in CANCEL_METHODS) return null
        val activeSid = sid ?: return null
        val meta = envelope.get("meta") as? JsonObject ?: return null
        val params = rpc.get("params") as? JsonObject ?: return null
        if (meta.get("sid").asStringOrNull() != activeSid || !validMeta(meta) ||
            envelope.get("jsb").asStringOrNull() != "1.0" || rpc.get("jsonrpc").asStringOrNull() != "2.0" ||
            !rpc.keySet().all { it in NOTIFICATION_KEYS } ||
            (params.has("reason") && params.get("reason").asStringOrNull() == null) ||
            !validJsonNumbers(envelope)
        ) return null
        return params.get("requestId").asStringOrNull()?.takeIf { it.isNotEmpty() }
    }

    fun businessCancellationResponse(call: BusinessCall): String? =
        if (sid == call.sid) callFailure(call, -32002, "Cancelled") else null

    fun progressNotification(call: BusinessCall, seq: Long, chunk: JsonElement?): String? {
        if (!call.supportsProgress || !callbacksNegotiated || sid != call.sid || seq !in 0L..MAX_SAFE_INTEGER) return null
        return checkedNotification(call.sid, "bridge.progress", JsonObject().apply {
            addProperty("requestId", call.id)
            addProperty("seq", seq)
            if (chunk != null) add("chunk", chunk)
        })
    }

    fun finishBusinessCall(call: BusinessCall, result: Result<JsonElement>): String? {
        if (sid != call.sid) return null
        val error = result.exceptionOrNull()
        if (error is MediaFailure) return callFailure(call, error.code, checkNotNull(error.message))
        if (error is InvalidBusinessParamsException) return failure(call.id, call.sid, -32602, "Invalid params")
        return try {
            val value = result.getOrNull() ?: return callFailure(call, -32603, "Internal error")
            validateOutboundValue(value, depth = 2, limit = maxMessageBytes) // envelope and RPC
            val reply = success(call.id, call.sid, value)
            if (exceedsMessageLimit(reply)) callFailure(call, -32006, "Payload too large") else reply
        } catch (_: ReplyTooLargeException) {
            callFailure(call, -32006, "Payload too large")
        } catch (_: RuntimeException) {
            callFailure(call, -32603, "Internal error")
        }
    }

    private fun callFailure(call: BusinessCall, code: Int, message: String): String =
        if (call.upload != null) uploadFailure(call.id, call.sid, code, message)
        else failure(call.id, call.sid, code, message)

    private fun updateSubscriptions(
        id: String,
        method: String,
        sid: String,
        events: List<String>,
        afterResponse: (() -> Unit) -> Unit,
    ): String {
        if (method == UNSUBSCRIBE) {
            val reply = success(id, sid, JsonObject().apply { add("unsubscribed", strings(events)) })
            if (exceedsMessageLimit(reply)) return failure(id, sid, -32006, "Payload too large")
            for (name in events) unsubscribe(name)
            return reply
        }

        fun subscriptionReply(accepted: Set<String>) = success(id, sid, JsonObject().apply {
            add("subscribed", strings(accepted))
            add("denied", strings(events.filterNot(accepted::contains)))
        })
        val available = availableEvents()
        val accepted = events.filterTo(linkedSetOf(), available::contains)
        var reply = subscriptionReply(accepted)
        // Check the acknowledgement size before creating any subscription or observer.
        if (exceedsMessageLimit(reply)) return failure(id, sid, -32006, "Payload too large")
        val newObservers = accepted.filter { it in observedEvents && it !in subscriptions }
        for (name in newObservers) {
            if (!subscribeObservedEvent(name)) accepted.remove(name)
        }
        if (newObservers.any { it !in accepted }) {
            reply = subscriptionReply(accepted)
            if (exceedsMessageLimit(reply)) {
                for (name in newObservers) unsubscribe(name)
                return failure(id, sid, -32006, "Payload too large")
            }
        }
        if (accepted.isNotEmpty()) {
            val pending = accepted.associateWith { name -> subscriptions.getOrPut(name, ::EventSubscription) }
            afterResponse {
                // A delayed response can only acknowledge the exact subscription it created or reused.
                for ((name, subscription) in pending) {
                    if (subscriptions[name] === subscription) subscription.acknowledged = true
                }
            }
        }
        return reply
    }

    private fun subscribeObservedEvent(name: String): Boolean {
        val subscription = EventSubscription()
        val observe = observedEvents.getValue(name)
        subscription.stop = observe { payload ->
            if (subscriptions[name] === subscription) emitEvent(name, payload)
        } ?: return false
        subscriptions[name] = subscription
        return true
    }

    private fun unsubscribe(name: String) {
        val stop = subscriptions.remove(name)?.stop ?: return
        try {
            stop()
        } catch (_: RuntimeException) {
            // The event source may already be unavailable. The subscription is retired.
        }
    }

    private fun negotiate(id: String, params: JsonObject?): String {
        val protocols = params?.get("protocols") as? JsonArray
        val versionSet = protocols?.mapNotNull { it.asSafeIntegerOrNull()?.takeIf { n -> n > 0 } }?.toSet()
        val sdk = params?.get("sdk") as? JsonObject
        val wants = params?.get("wants") as? JsonArray
        val validSdk = params?.has("sdk") != true ||
            (sdk?.get("name").asStringOrNull() != null && sdk?.get("version").asStringOrNull() != null)
        val validWants = params?.has("wants") != true ||
            (wants != null && wants.mapNotNull { it.asStringOrNull() }.toSet().size == wants.size())
        if (protocols == null || protocols.isEmpty || versionSet == null || versionSet.size != protocols.size() ||
            !validSdk || !validWants
        ) return failure(id, null, -32602, "Invalid handshake params")

        if (1L !in versionSet) {
            val data = JsonObject().apply { add("supported", JsonArray().apply { add(1) }) }
            return failure(id, null, -32004, "Unsupported protocol", data)
        }

        val sessionId = sid ?: UUID.randomUUID().toString()
        val wantsCallbacks = canReportProgress && wants?.any { it.asStringOrNull() == "callbacks" } == true
        val result = JsonObject().apply {
            addProperty("jsb", "1.0")
            addProperty("sid", sessionId)
            add("host", JsonObject().apply {
                addProperty("platform", "android")
                addProperty("name", "android-wml")
                addProperty("version", "1.0.0")
            })
            add("capabilities", JsonObject().apply {
                add("methods", JsonObject().apply {
                    val mediaMethods = if (media == null) emptySet() else setOf(MEDIA_CHOOSE)
                    val uploadMethods = if (uploadOrigin == null) emptySet() else setOf(UPLOAD)
                    for (method in methods.keys + businessMethods.keys + mediaMethods + uploadMethods) {
                        add(method, JsonObject().apply { add("versions", JsonArray().apply { add(1) }) })
                    }
                })
                add("events", strings(availableEvents()))
                add("features", JsonArray().apply {
                    if (canCancel) add("cancel")
                    if (wantsCallbacks) add("callbacks")
                })
            })
            add("limits", JsonObject().apply {
                addProperty("maxMessageBytes", maxMessageBytes)
                // A second wire slot lets the SDK release an in-use handle or observe upload busy.
                addProperty("maxInflight", if (uploadOrigin == null) 1 else 2)
                addProperty("defaultTimeoutMs", DEFAULT_TIMEOUT_MS)
            })
        }
        val reply = success(id, sessionId, result)
        if (exceedsMessageLimit(reply)) return failure(id, null, -32006, "Payload too large")
        sid = sessionId
        callbacksNegotiated = wantsCallbacks
        return reply
    }

    private fun checkedNotification(sid: String, method: String, params: JsonObject): String? = try {
        validateOutboundValue(params, depth = 2, limit = maxMessageBytes) // envelope and RPC
        val raw = JsonObject().apply {
            addProperty("jsb", "1.0")
            add("meta", JsonObject().apply { addProperty("sid", sid) })
            add("rpc", JsonObject().apply {
                addProperty("jsonrpc", "2.0")
                addProperty("method", method)
                add("params", params)
            })
        }.toString()
        raw.takeUnless(::exceedsMessageLimit)
    } catch (_: RuntimeException) {
        null
    }

    private fun exceedsMessageLimit(raw: String) =
        raw.length > maxMessageBytes || raw.toByteArray(Charsets.UTF_8).size > maxMessageBytes

    companion object {
        const val MAX_MESSAGE_BYTES = 65_536
        private const val DEFAULT_TIMEOUT_MS = 15_000L
        private const val MAX_RECORDED_IDS = 4_096
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991
        private const val MAX_JSON_NESTING = 255
        private const val HELLO = "bridge.hello"
        private const val ECHO = "conformance.echo"
        private const val DEVICE_INFO = "device.getInfo"
        private const val NETWORK_STATUS = "network.getStatus"
        private const val TOAST_SHOW = "ui.toast.show"
        private const val MEDIA_CHOOSE = "media.chooseMedia"
        private const val MEDIA_RELEASE = "media.release"
        private const val UPLOAD = "transfer.upload"
        private val UPLOAD_ERRORS = mapOf(
            -32602 to ("Invalid params" to "invalid_params"),
            -32603 to ("Internal error" to "internal_error"),
            -32001 to ("Timeout" to "timeout"),
            -32002 to ("Cancelled" to "cancelled"),
            -32003 to ("Permission denied" to "permission_denied"),
            -32006 to ("Payload too large" to "payload_too_large"),
            -32007 to ("User denied" to "user_denied"),
            -32008 to ("Rate limited" to "rate_limited"),
            -32010 to ("Busy" to "busy"),
        )
        private val UPLOAD_REASONS = setOf(
            "unsupported_image", "invalid_response", "network_failure", "redirect_denied",
            "endpoint_not_allowed", "forbidden_header", "field_not_allowed", "compression_not_allowed",
        )
        private val MEDIA_ID = Regex("[0-9a-f]{32}")
        private val CHOOSE_KEYS = setOf("mediaType", "sourceType", "count")
        private const val SUBSCRIBE = "bridge.subscribe"
        private const val UNSUBSCRIBE = "bridge.unsubscribe"
        private const val NETWORK_STATUS_CHANGED = "network.statusChanged"
        private val METHOD_VERSION = Regex("[1-9][0-9]*")
        private val NOTIFICATION_KEYS = setOf("jsonrpc", "method", "params")
        private val REQUEST_KEYS = NOTIFICATION_KEYS + "id"
        private val CANCEL_METHODS = setOf("bridge.cancel", "bridge.cancel@1")
        private val NOTIFICATION_ONLY = CANCEL_METHODS + setOf("bridge.event", "bridge.progress")

        private fun query(read: () -> JsonObject): (JsonObject?) -> JsonObject = { params ->
            if (params != null && params.size() != 0) {
                throw InvalidNativeParamsException("Expected an empty params object")
            }
            read()
        }

        private fun parseObject(raw: String): JsonObject? = try {
            JsonReader(StringReader(raw)).use { reader ->
                reader.strictness = Strictness.STRICT
                val result = JsonParser.parseReader(reader) as? JsonObject
                if (reader.peek() == JsonToken.END_DOCUMENT) result else null
            }
        } catch (_: JsonParseException) {
            null
        } catch (_: IOException) {
            null
        }

        private fun JsonElement?.asStringOrNull(): String? =
            (this as? JsonPrimitive)?.takeIf { it.isString }?.asString

        private fun JsonElement?.asSafeIntegerOrNull(): Long? {
            val number = (this as? JsonPrimitive)?.takeIf { it.isNumber }?.asDouble ?: return null
            return number.takeIf { abs(it) <= MAX_SAFE_INTEGER && it % 1 == 0.0 }?.toLong()
        }

        private fun JsonElement?.isSingleChoice(expected: String): Boolean =
            this is JsonArray && size() == 1 && get(0).asStringOrNull() == expected

        private fun releaseIds(params: JsonObject?): List<String> {
            val ids = params?.get("ids") as? JsonArray
            if (params?.size() != 1 || ids == null || ids.size() !in 1..32) {
                throw InvalidNativeParamsException("Invalid params")
            }
            return ids.map { item ->
                item.asStringOrNull()?.takeIf(MEDIA_ID::matches)
                    ?: throw InvalidNativeParamsException("Invalid params")
            }
        }

        private fun validMeta(meta: JsonObject) =
            (!meta.has("sid") || meta.get("sid").asStringOrNull()?.isNotEmpty() == true) &&
                (!meta.has("traceId") || meta.get("traceId").asStringOrNull() != null) &&
                (!meta.has("timeout") || meta.get("timeout").asSafeIntegerOrNull()?.let { it >= 0 } == true) &&
                (!meta.has("ts") || meta.get("ts").asSafeIntegerOrNull()?.let { it >= 0 } == true)

        private fun validMethod(method: String): Boolean {
            val path = method.substringBefore('@')
            return isQualifiedBaseName(path) && ('@' !in method || METHOD_VERSION.matches(method.substringAfter('@')))
        }

        private fun eventNames(params: JsonObject?): List<String>? {
            val events = params?.get("events") as? JsonArray ?: return null
            if (events.isEmpty) return null
            val names = LinkedHashSet<String>()
            for (event in events) {
                val name = event.asStringOrNull() ?: return null
                if (!isQualifiedBaseName(name) || !names.add(name)) return null
            }
            return names.toList()
        }

        private fun validJsonNumbers(root: JsonObject): Boolean {
            val nodes = ArrayDeque<JsonElement>()
            nodes.add(root)
            while (nodes.isNotEmpty()) {
                val node = nodes.removeLast()
                when (node) {
                    is JsonObject -> node.entrySet().forEach { nodes.add(it.value) }
                    is JsonArray -> node.forEach { nodes.add(it) }
                    is JsonPrimitive -> if (node.isNumber && !validJsonNumber(node.asDouble)) return false
                }
            }
            return true
        }

        private fun validJsonNumber(value: Double): Boolean =
            value.isFinite() && (value % 1 != 0.0 || abs(value) <= MAX_SAFE_INTEGER)

        private class ReplyTooLargeException : RuntimeException()

        private fun validateOutboundValue(root: JsonElement, depth: Int, limit: Int) {
            // Count a lower bound before serializing mutable Gson trees supplied by the app.
            var remainingChars = limit
            fun consume(chars: Int) {
                if (chars > remainingChars) throw ReplyTooLargeException()
                remainingChars -= chars
            }
            fun visit(value: JsonElement, depth: Int) {
                when (value) {
                    is JsonObject -> {
                        require(depth < MAX_JSON_NESTING)
                        consume(2)
                        for ((name, child) in value.entrySet()) {
                            consume(name.length)
                            consume(3) // Quotes and colon
                            visit(child, depth + 1)
                        }
                    }
                    is JsonArray -> {
                        require(depth < MAX_JSON_NESTING)
                        consume(2)
                        for (child in value) visit(child, depth + 1)
                    }
                    is JsonPrimitive -> {
                        val literal = value.asString
                        consume(literal.length)
                        if (value.isString) consume(2)
                        if (value.isNumber) require(literal.toDoubleOrNull()?.let(::validJsonNumber) == true)
                    }
                    is JsonNull -> consume(4)
                    else -> throw IllegalArgumentException()
                }
            }
            visit(root, depth)
        }

        private fun response(id: String, sid: String?, key: String, value: JsonElement): String =
            JsonObject().apply {
                addProperty("jsb", "1.0")
                if (sid != null) add("meta", JsonObject().apply { addProperty("sid", sid) })
                add("rpc", JsonObject().apply {
                    addProperty("jsonrpc", "2.0")
                    addProperty("id", id)
                    add(key, value)
                })
            }.toString()

        private fun success(id: String, sid: String, result: JsonElement) = response(id, sid, "result", result)

        private fun strings(values: Iterable<String>) = JsonArray().apply { values.forEach { add(it) } }

        private fun uploadFailure(id: String, sid: String?, code: Int, detail: String?): String {
            // Exceptions from image preparation, policy hooks or HTTPS must never expose their text.
            val safeCode = if (code in UPLOAD_ERRORS) code else -32603
            val (message, defaultReason) = UPLOAD_ERRORS.getValue(safeCode)
            val reason = detail?.takeIf { it in UPLOAD_REASONS } ?: defaultReason
            return failure(id, sid, safeCode, message, JsonObject().apply { addProperty("reason", reason) })
        }

        private fun failure(id: String, sid: String?, code: Int, message: String, data: JsonObject? = null) =
            response(id, sid, "error", JsonObject().apply {
                addProperty("code", code)
                addProperty("message", message)
                if (data != null) add("data", data)
            })
    }
}
