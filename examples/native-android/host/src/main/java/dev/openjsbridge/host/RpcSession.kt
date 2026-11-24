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
) {
    internal data class BusinessCall(
        val handler: suspend (JsonObject) -> JsonElement,
        val params: JsonObject,
        val id: String,
        val sid: String,
    )

    private class NetworkSubscription {
        var acknowledged = false
        var stop: (() -> Unit)? = null
    }

    private var sid: String? = null
    private val helloIds = HashSet<String>()
    private val requestIds = HashSet<String>()
    private val methods = buildMap<String, (JsonObject?) -> JsonObject> {
        if (enableEcho) put(ECHO) { params -> params ?: JsonObject() }
        modules.device?.let { device -> put(DEVICE_INFO) { device.info() } }
        modules.network?.let { network -> put(NETWORK_STATUS) { network.status().snapshot() } }
    }
    private val businessMethods = businessMethods.indexBusinessMethods()
    private val networkEvents = modules.networkEvents
    private var eventReceiver: ((String) -> Unit)? = null
    private var networkSubscription: NetworkSubscription? = null

    fun confirmEventReceiver(post: (String) -> Unit) {
        if (networkEvents != null) eventReceiver = post
    }

    fun close() {
        sid = null
        eventReceiver = null
        unsubscribeNetwork()
    }

    fun receive(
        raw: String,
        businessBusy: Boolean = false,
        onBusinessCall: ((BusinessCall) -> Unit)? = null,
        afterResponse: (() -> Unit) -> Unit = {},
    ): String? {
        if (exceedsMessageLimit(raw)) return null
        val envelope = parseObject(raw) ?: return null
        val rpc = envelope.get("rpc") as? JsonObject ?: return null

        // There are no incoming notifications or responses in this host.
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
        val params = rpc.get("params") as? JsonObject
        val versionOne = method?.removeSuffix("@1").orEmpty()
        val business = businessMethods[versionOne]
        val invalidMeta = when {
            !envelope.has("meta") -> false
            meta == null -> true
            else -> !validMeta(meta)
        }
        if (envelope.get("jsb").asStringOrNull() != "1.0" ||
            rpc.get("jsonrpc").asStringOrNull() != "2.0" ||
            method == null || !validMethod(method) ||
            !rpc.keySet().all { it in REQUEST_KEYS } ||
            (rpc.has("params") && params == null) || invalidMeta ||
            !validJsonNumbers(envelope) || method in NOTIFICATION_ONLY
        ) return failure(id, replySid, -32600, "Invalid request")

        if (!hello && incomingSid == null) return failure(id, activeSid, -32009, "Session expired")
        if (businessBusy) return failure(id, replySid, -32008, "Rate limited")
        val handler = methods[versionOne]
        val control = versionOne == SUBSCRIBE || versionOne == UNSUBSCRIBE
        if ((hello || handler != null || control || business != null) && meta?.get("timeout").asSafeIntegerOrNull() == 0L) {
            return failure(id, replySid, -32602, "Invalid request timeout")
        }

        if (hello) return negotiate(id, params)
        val requestSid = activeSid ?: return null
        if (control) {
            val events = eventNames(params) ?: return failure(id, requestSid, -32602, "Invalid event names")
            return updateSubscriptions(id, versionOne, requestSid, events, afterResponse)
        }
        if (handler != null) {
            if (versionOne != ECHO && params != null && params.size() != 0) {
                return failure(id, requestSid, -32602, "Expected an empty params object")
            }
            val result = success(id, requestSid, handler(params))
            if (exceedsMessageLimit(result)) return failure(id, requestSid, -32006, "Payload too large")
            return result
        }
        if (business != null) {
            if (onBusinessCall == null) return failure(id, requestSid, -32603, "Internal error")
            onBusinessCall(BusinessCall(business.handler, params ?: JsonObject(), id, requestSid))
            return null
        }
        return failure(id, requestSid, -32601, "Method not found")
    }

    fun finishBusinessCall(call: BusinessCall, result: Result<JsonElement>): String? {
        if (sid != call.sid) return null
        val error = result.exceptionOrNull()
        if (error is InvalidBusinessParamsException) return failure(call.id, call.sid, -32602, "Invalid params")
        return try {
            val value = result.getOrNull() ?: return failure(call.id, call.sid, -32603, "Internal error")
            validateBusinessResult(value)
            val reply = success(call.id, call.sid, value)
            if (exceedsMessageLimit(reply)) failure(call.id, call.sid, -32006, "Payload too large") else reply
        } catch (_: ReplyTooLargeException) {
            failure(call.id, call.sid, -32006, "Payload too large")
        } catch (_: RuntimeException) {
            failure(call.id, call.sid, -32603, "Internal error")
        }
    }

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
            if (NETWORK_CHANGED in events) unsubscribeNetwork()
            return reply
        }

        if (NETWORK_CHANGED in events && eventReceiver != null) {
            val reply = success(id, sid, JsonObject().apply {
                add("subscribed", strings(listOf(NETWORK_CHANGED)))
                add("denied", strings(events.filterNot { it == NETWORK_CHANGED }))
            })
            // Confirm we can send the acceptance before starting an observer.
            if (exceedsMessageLimit(reply)) return failure(id, sid, -32006, "Payload too large")
            if (subscribeNetwork(sid, afterResponse)) return reply
        }
        val reply = success(id, sid, JsonObject().apply {
            add("subscribed", JsonArray())
            add("denied", strings(events))
        })
        return if (exceedsMessageLimit(reply)) failure(id, sid, -32006, "Payload too large") else reply
    }

    private fun subscribeNetwork(sid: String, afterResponse: (() -> Unit) -> Unit): Boolean {
        val events = networkEvents ?: return false
        val subscription = networkSubscription ?: NetworkSubscription().also { current ->
            networkSubscription = current
            current.stop = events.observe { type ->
                if (networkSubscription === current && current.acknowledged) {
                    eventReceiver?.invoke(networkNotification(sid, type))
                }
            }
        }
        if (subscription.stop == null) {
            networkSubscription = null
            return false
        }
        afterResponse {
            if (networkSubscription === subscription) subscription.acknowledged = true
        }
        return true
    }

    private fun unsubscribeNetwork() {
        val previous = networkSubscription
        networkSubscription = null
        previous?.stop?.invoke()
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
        val result = JsonObject().apply {
            addProperty("jsb", "1.0")
            addProperty("sid", sessionId)
            add("host", JsonObject().apply {
                addProperty("platform", "android")
                addProperty("name", "android-wml")
                addProperty("version", "0.1.0")
            })
            add("capabilities", JsonObject().apply {
                add("methods", JsonObject().apply {
                    for (method in methods.keys + businessMethods.keys) {
                        add(method, JsonObject().apply { add("versions", JsonArray().apply { add(1) }) })
                    }
                })
                add("events", JsonArray().apply { if (eventReceiver != null) add(NETWORK_CHANGED) })
                add("features", JsonArray())
            })
            add("limits", JsonObject().apply {
                addProperty("maxMessageBytes", MAX_MESSAGE_BYTES)
                addProperty("maxInflight", 1)
                addProperty("defaultTimeoutMs", 15_000)
            })
        }
        val reply = success(id, sessionId, result)
        if (exceedsMessageLimit(reply)) return failure(id, null, -32006, "Payload too large")
        sid = sessionId
        return reply
    }

    companion object {
        const val MAX_MESSAGE_BYTES = 65_536
        private const val MAX_RECORDED_IDS = 4_096
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991
        private const val MAX_JSON_NESTING = 255
        private const val HELLO = "bridge.hello"
        private const val ECHO = "conformance.echo"
        private const val DEVICE_INFO = "device.getInfo"
        private const val NETWORK_STATUS = "network.getStatus"
        private const val SUBSCRIBE = "bridge.subscribe"
        private const val UNSUBSCRIBE = "bridge.unsubscribe"
        private const val NETWORK_CHANGED = "network.changed"
        private val METHOD_VERSION = Regex("[1-9][0-9]*")
        private val REQUEST_KEYS = setOf("jsonrpc", "id", "method", "params")
        private val NOTIFICATION_ONLY = setOf("bridge.cancel", "bridge.event", "bridge.progress")

        private fun exceedsMessageLimit(raw: String) =
            raw.length > MAX_MESSAGE_BYTES || raw.toByteArray(Charsets.UTF_8).size > MAX_MESSAGE_BYTES

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
                when (val node = nodes.removeLast()) {
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

        private fun validateBusinessResult(root: JsonElement) {
            // Count a lower bound before serializing mutable Gson trees supplied by the app.
            var remainingChars = MAX_MESSAGE_BYTES
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
            visit(root, depth = 2) // The response envelope and RPC object already occupy two levels.
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

        private fun strings(values: List<String>) = JsonArray().apply { values.forEach { add(it) } }

        private fun networkNotification(sid: String, type: NetworkType) = JsonObject().apply {
            addProperty("jsb", "1.0")
            add("meta", JsonObject().apply { addProperty("sid", sid) })
            add("rpc", JsonObject().apply {
                addProperty("jsonrpc", "2.0")
                addProperty("method", "bridge.event")
                add("params", JsonObject().apply {
                    addProperty("name", NETWORK_CHANGED)
                    add("payload", type.snapshot())
                })
            })
        }.toString()

        private fun failure(id: String, sid: String?, code: Int, message: String, data: JsonObject? = null) =
            response(id, sid, "error", JsonObject().apply {
                addProperty("code", code)
                addProperty("message", message)
                if (data != null) add("data", data)
            })
    }
}
