package dev.openjsbridge.example

import com.google.gson.JsonArray
import com.google.gson.JsonElement
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

/** The demo's only RPCs are a handshake and a synchronous, side-effect-free echo. */
internal class RpcSession(private val enableEcho: Boolean) {
    private var sid: String? = null
    private val helloIds = HashSet<String>()
    private val requestIds = HashSet<String>()

    fun receive(raw: String): String? {
        if (exceedsMessageLimit(raw)) return null
        val envelope = parseObject(raw) ?: return null
        val rpc = envelope.get("rpc") as? JsonObject ?: return null

        // There are no incoming notifications or responses in this host.
        val id = rpc.get("id").asStringOrNull() ?: return null
        if (id.codePointCount(0, id.length) !in 1..128 || !rpc.has("method") ||
            rpc.has("result") || rpc.has("error")
        ) return null

        val method = rpc.get("method").asStringOrNull()
        val hello = method == HELLO
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
        if (meta?.get("timeout").asSafeIntegerOrNull() == 0L) {
            return failure(id, replySid, -32602, "Invalid request timeout")
        }

        if (hello) return negotiate(id, params)
        val requestSid = activeSid ?: return null
        if (enableEcho && (method == ECHO || method == "$ECHO@1")) {
            val result = success(id, requestSid, params ?: JsonObject())
            if (exceedsMessageLimit(result)) return failure(id, requestSid, -32006, "Payload too large")
            return result
        }
        return failure(id, requestSid, -32601, "Method not found")
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

        val sessionId = sid ?: UUID.randomUUID().toString().also { sid = it }
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
                    if (enableEcho) add(ECHO, JsonObject().apply { add("versions", JsonArray().apply { add(1) }) })
                })
                add("events", JsonArray())
                add("features", JsonArray())
            })
            add("limits", JsonObject().apply {
                addProperty("maxMessageBytes", MAX_MESSAGE_BYTES)
                addProperty("maxInflight", 1)
                addProperty("defaultTimeoutMs", 15_000)
            })
        }
        return success(id, sessionId, result)
    }

    companion object {
        const val MAX_MESSAGE_BYTES = 65_536
        private const val MAX_RECORDED_IDS = 4_096
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991
        private const val HELLO = "bridge.hello"
        private const val ECHO = "conformance.echo"
        private val METHOD_SEGMENT = Regex("[a-z][a-zA-Z0-9]*")
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
            if (path.startsWith("rpc.") || '.' !in path || path.split('.').any { !METHOD_SEGMENT.matches(it) }) {
                return false
            }
            return '@' !in method || METHOD_VERSION.matches(method.substringAfter('@'))
        }

        private fun validJsonNumbers(root: JsonObject): Boolean {
            val nodes = ArrayDeque<JsonElement>()
            nodes.add(root)
            while (nodes.isNotEmpty()) {
                when (val node = nodes.removeLast()) {
                    is JsonObject -> node.entrySet().forEach { nodes.add(it.value) }
                    is JsonArray -> node.forEach { nodes.add(it) }
                    is JsonPrimitive -> if (node.isNumber) {
                        val n = node.asDouble
                        if (!n.isFinite() || (n % 1 == 0.0 && abs(n) > MAX_SAFE_INTEGER)) return false
                    }
                }
            }
            return true
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

        private fun success(id: String, sid: String, result: JsonObject) = response(id, sid, "result", result)

        private fun failure(id: String, sid: String?, code: Int, message: String, data: JsonObject? = null) =
            response(id, sid, "error", JsonObject().apply {
                addProperty("code", code)
                addProperty("message", message)
                if (data != null) add("data", data)
            })
    }
}
