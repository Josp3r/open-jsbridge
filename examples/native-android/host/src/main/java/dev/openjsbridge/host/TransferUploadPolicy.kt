package dev.openjsbridge.host

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.net.URI
import java.net.URISyntaxException
import java.net.URL
import java.util.Locale
import java.util.concurrent.CancellationException
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Authorizes one exact HTTPS destination for one trusted Web origin. Form and header predicates
 * accept individual values. [confirm] can request per-upload consent. [credentials] supplies fresh,
 * endpoint-specific headers after authorization, immediately before starting the request.
 */
class TransferUploadEndpoint(
    origin: String,
    internal val url: String,
    fileFields: Set<String> = setOf("file"),
    formFields: Map<String, (String) -> Boolean> = emptyMap(),
    headers: Map<String, (String) -> Boolean> = emptyMap(),
    responseTypes: Set<String> = setOf("text/plain", "application/json"),
    internal val maxEdge: Int = 4096,
    internal val maxQuality: Int = 100,
    internal val confirm: suspend () -> Boolean = { true },
    internal val credentials: () -> Map<String, String> = { emptyMap() },
) {
    internal val origin = requireNotNull(DocumentTransport.exactOrigin(origin)) { "Expected an exact HTTPS origin" }
    internal val target: URL = requireNotNull(endpointUri(url)) { "Expected a complete HTTPS endpoint" }.let { uri ->
        // Keep the registered route and the HTTP client's actual request path identical.
        val path = URI(uri.toASCIIString()).rawPath.ifEmpty { "/" }
        require(url.toHttpUrlOrNull()?.encodedPath == path) { "Expected a path preserved by the HTTP client" }
        uri.toURL()
    }
    internal val fileFields = fileFields.toSet()
    internal val formFields = formFields.toMap()
    internal val headers = headers.mapKeys { it.key.lowercase(Locale.ROOT) }
    internal val responseTypes = responseTypes.mapTo(mutableSetOf()) { it.lowercase(Locale.ROOT) }

    init {
        require(fileFields.all(FIELD_NAME::matches) && formFields.keys.all(FIELD_NAME::matches))
        require(headers.keys.all(HEADER_NAME::matches) && this.headers.size == headers.size)
        require(this.responseTypes.all { RESPONSE_TYPE.matches(it) })
        require(maxEdge in 1..4096 && maxQuality in 1..100)
    }
}

/** Only the endpoints registered for the confirmed document's origin are available to that document. */
class TransferUploadPolicy(endpoints: Collection<TransferUploadEndpoint>) {
    private val byOrigin = endpoints.groupBy { it.origin }.mapValues { (_, group) ->
        group.associateBy { it.url }.also { require(it.size == group.size) { "Duplicate upload endpoint" } }
    }

    internal fun allows(origin: String): Boolean = byOrigin[origin]?.values?.any { it.fileFields.isNotEmpty() } == true

    internal fun authorize(origin: String, params: JsonObject?): AuthorizedUpload {
        if (params == null || params.keySet() != setOf("id", "request")) invalid()
        val id = params["id"].stringValue()
        if (!MEDIA_ID.matches(id)) invalid()
        val request = params["request"] as? JsonObject ?: invalid()
        if (!REQUEST_KEYS.containsAll(request.keySet())) invalid()
        val url = request["url"].stringValue()
        if (endpointUri(url) == null || request.has("method") && request["method"].stringValue() != "POST") invalid()
        val field = request["fieldName"]?.stringValue() ?: "file"
        if (!FIELD_NAME.matches(field)) invalid()

        val form = stringMap(request["formData"], FIELD_NAME)
        if (field in form) invalid()
        val headers = stringMap(request["headers"], HEADER_NAME)
        if (headers.values.any { !validHeaderValue(it) } ||
            headers.keys.map { it.lowercase(Locale.ROOT) }.toSet().size != headers.size) invalid()
        val metadataBytes = listOf(form, headers).sumOf { fields ->
            fields.entries.sumOf { (name, value) -> name.length.toLong() + value.toByteArray(Charsets.UTF_8).size }
        }
        if (metadataBytes > 16 * 1024) tooLarge()

        val compression = request["compress"]?.let { it as? JsonObject ?: invalid() }
        if (compression != null && !COMPRESS_KEYS.containsAll(compression.keySet())) invalid()
        val edge = compression?.get("maxEdge")?.integer(1..4096) ?: 2048
        val quality = compression?.get("quality")?.integer(1..100) ?: 80

        val endpoint = byOrigin[origin]?.get(url) ?: denied("endpoint_not_allowed")
        if (field !in endpoint.fileFields) denied("field_not_allowed")
        if (edge > endpoint.maxEdge || quality > endpoint.maxQuality) denied("compression_not_allowed")
        for ((key, value) in form) {
            if (!hostRule { endpoint.formFields[key]?.invoke(value) == true }) denied("field_not_allowed")
        }
        for ((key, value) in headers) {
            val name = key.lowercase(Locale.ROOT)
            if (reservedHeader(name) || !hostRule { endpoint.headers[name]?.invoke(value) == true }) {
                denied("forbidden_header")
            }
        }
        return AuthorizedUpload(id, endpoint, field, form, headers, edge, quality)
    }
}

internal class AuthorizedUpload(
    val id: String,
    private val endpoint: TransferUploadEndpoint,
    val fieldName: String,
    val formData: Map<String, String>,
    private val pageHeaders: Map<String, String>,
    val maxEdge: Int,
    val quality: Int,
) {
    val target get() = endpoint.target
    val responseTypes get() = endpoint.responseTypes
    val confirm get() = endpoint.confirm

    fun requestHeaders(): Map<String, String> {
        val merged = pageHeaders.toMutableMap()
        val pageNames = pageHeaders.keys.mapTo(mutableSetOf()) { it.lowercase(Locale.ROOT) }
        val hostNames = mutableSetOf<String>()
        val credentials = hostRule { endpoint.credentials().toMap() }
        for ((key, value) in credentials) {
            val name = key.lowercase(Locale.ROOT)
            if (name in pageNames) denied("forbidden_header")
            if (!HEADER_NAME.matches(key) || !validHeaderValue(value) || !hostNames.add(name) ||
                (reservedHeader(name) && name !in HOST_AUTH_HEADERS)) internalError()
            merged[key] = value
        }
        return merged
    }
}

private val REQUEST_KEYS = setOf("url", "method", "fieldName", "headers", "formData", "compress")
private val COMPRESS_KEYS = setOf("maxEdge", "quality")
private val HEADER_PATH = listOf("rpc", "params", "request", "headers")
private val MEDIA_ID = Regex("[0-9a-f]{32}")
private val FIELD_NAME = Regex("[A-Za-z0-9_-]{1,64}")
private val HEADER_NAME = Regex("[!#$%&'*+.^_\u0060|~0-9A-Za-z-]{1,128}")
private val RESPONSE_TYPE = Regex("(?:text/[a-z0-9!#$%&'+.^_~-]+|application/(?:[a-z0-9!#$%&'+.^_~-]+\\+)?json)")
private val HOST_AUTH_HEADERS = setOf("authorization", "cookie")
private val RESERVED_HEADERS = setOf("host", "connection", "transfer-encoding", "cookie2", "keep-alive",
    "te", "trailer", "upgrade", "forwarded", "via", "expect", "accept-encoding")

private fun reservedHeader(name: String) = name in HOST_AUTH_HEADERS || name in RESERVED_HEADERS ||
    name.startsWith("proxy-") || name.startsWith("content-") || name.startsWith("x-forwarded-")

/** Gson's object tree keeps only the last value of an exactly repeated member. */
internal fun hasRepeatedUploadHeader(raw: String, params: JsonObject?): Boolean {
    val request = params?.get("request") as? JsonObject ?: return false
    val headers = request["headers"] as? JsonObject ?: return false
    if (headers.size() == 0) return false
    return JsonReader(raw.reader()).use { reader ->
        reader.strictness = Strictness.STRICT
        reader.countUploadHeaders(0) > headers.size()
    }
}

/** Read only the named path in the already validated frame; skip unrelated values wholesale. */
private fun JsonReader.countUploadHeaders(depth: Int): Int {
    if (peek() != JsonToken.BEGIN_OBJECT) {
        skipValue()
        return 0
    }
    beginObject()
    var count = 0
    while (hasNext()) {
        val name = nextName()
        if (depth < HEADER_PATH.size && name == HEADER_PATH[depth]) {
            count = countUploadHeaders(depth + 1) // Match the tree's last value at each parent.
        } else {
            if (depth == HEADER_PATH.size) count++
            skipValue()
        }
    }
    endObject()
    return count
}

private fun endpointUri(raw: String): URI? {
    if (!raw.startsWith("https://")) return null
    val uri = try { URI(raw) } catch (_: URISyntaxException) { return null }
    if (uri.rawAuthority == null || uri.rawQuery != null || uri.rawFragment != null) return null
    return uri.takeIf { DocumentTransport.exactOrigin("https://" + uri.rawAuthority) != null }
}

private fun stringMap(element: JsonElement?, keyPattern: Regex): Map<String, String> {
    if (element == null) return emptyMap()
    val obj = element as? JsonObject ?: invalid()
    if (obj.size() > 16) tooLarge()
    return obj.entrySet().associate { (key, value) ->
        if (!keyPattern.matches(key)) invalid()
        key to value.stringValue()
    }
}

private fun validHeaderValue(value: String) = value.none { it < ' ' || it == '\u007f' }
private fun JsonElement?.stringValue() = this?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString ?: invalid()
private fun JsonElement.integer(range: IntRange): Int {
    if (!isJsonPrimitive || !asJsonPrimitive.isNumber) invalid()
    val value = try {
        asBigDecimal.intValueExact()
    } catch (_: NumberFormatException) {
        invalid()
    } catch (_: ArithmeticException) {
        invalid()
    }
    return value.takeIf { it in range } ?: invalid()
}

private inline fun <T> hostRule(block: () -> T): T = try {
    block()
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (_: Exception) {
    internalError()
}

private fun invalid(): Nothing = throw MediaFailure(-32602, "invalid_params")
private fun tooLarge(): Nothing = throw MediaFailure(-32006, "payload_too_large")
private fun denied(reason: String): Nothing = throw MediaFailure(-32003, reason)
private fun internalError(): Nothing = throw MediaFailure(-32603, "internal_error")
