package dev.openjsbridge.host

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class TransferUploadPolicyTest {
    @Test fun anOriginNeedsAtLeastOneEndpointWithAnAllowedFileField() {
        val disabled = TransferUploadEndpoint(ORIGIN, URL, fileFields = emptySet())
        val other = TransferUploadEndpoint("https://other.example", URL)
        val disabledOrigin = TransferUploadPolicy(listOf(disabled, other))
        assertFalse(disabledOrigin.allows(ORIGIN))
        assertTrue(disabledOrigin.allows("https://other.example"))

        val enabledUrl = "$URL/active"
        val mixed = TransferUploadPolicy(listOf(disabled, TransferUploadEndpoint(ORIGIN, enabledUrl)))
        assertTrue(mixed.allows(ORIGIN))
        assertCode(-32003) { mixed.authorize(ORIGIN, params()) }
        assertEquals(enabledUrl, mixed.authorize(ORIGIN, params { addProperty("url", enabledUrl) }).target.toExternalForm())
    }

    @Test fun exactSourceAndConfiguredDestinationAreBothRequired() {
        val policy = TransferUploadPolicy(listOf(TransferUploadEndpoint(ORIGIN, URL)))
        assertTrue(policy.allows(ORIGIN))
        assertFalse(policy.allows("https://other.example"))
        val upload = policy.authorize(ORIGIN, params())
        assertEquals(URL, upload.target.toExternalForm())
        assertEquals(ID, upload.id)
        assertEquals("file", upload.fieldName)
        assertEquals(2048, upload.maxEdge)
        assertEquals(80, upload.quality)
        assertEquals(setOf("text/plain", "application/json"), upload.responseTypes)
        assertCode(-32003) { policy.authorize("https://other.example", params()) }
        for (unregistered in listOf(URL.replace(":443", ""), "$URL/", URL.replace("/photo", "/album"))) {
            assertCode(-32003) { policy.authorize(ORIGIN, params { addProperty("url", unregistered) }) }
        }
    }

    @Test fun endpointConfigurationRejectsAmbiguousOrNonHttpsDestinations() {
        for (url in listOf("http://upload.example/p", "https://user@upload.example/p",
            "https://upload.example/p?", "https://upload.example/p#frag", "https://upload.example:70000/p",
            "https://upload.example/photos/../upload", "https://upload.example/photos/%2e/upload")) {
            assertThrows(IllegalArgumentException::class.java) { TransferUploadEndpoint(ORIGIN, url) }
        }
        assertThrows(IllegalArgumentException::class.java) { TransferUploadEndpoint("$ORIGIN/path", URL) }
        assertThrows(IllegalArgumentException::class.java) {
            TransferUploadPolicy(listOf(TransferUploadEndpoint(ORIGIN, URL), TransferUploadEndpoint(ORIGIN, URL)))
        }
    }

    @Test fun parameterAndMethodShapesAreValidatedBeforePolicyChecks() {
        val policy = TransferUploadPolicy(listOf(TransferUploadEndpoint(ORIGIN, URL)))
        for (invalid in listOf(null, json("{}"), params().apply { addProperty("sid", "untrusted") },
            params().apply { addProperty("id", ID.uppercase()) }, params().apply { addProperty("request", "bad") })) {
            assertCode(-32602) { policy.authorize(ORIGIN, invalid) }
        }
        for (invalid in listOf(
            """{"method":"PUT"}""", """{"method":null}""", """{"url":"not a URL"}""",
            """{"url":"https://user@upload.example/photo"}""", """{"timeout":60}""",
            """{"fieldName":"bad name"}""", """{"formData":{"file":"duplicate"}}""",
            """{"formData":{"key":3}}""", """{"headers":{"Bad Name":"x"}}""",
            """{"headers":{"X-Note":"x\ny"}}""", """{"headers":{"X-Note":"a","x-note":"b"}}""",
            """{"compress":{"maxEdge":1.5}}""", """{"compress":{"maxEdge":4097}}""",
            """{"compress":{"quality":0}}""", """{"compress":{"quality":"80"}}""",
            """{"compress":{"other":1}}""", """{"compress":null}""",
        )) {
            assertCode(-32602) { policy.authorize(ORIGIN, params { json(invalid).entrySet().forEach { add(it.key, it.value) } }) }
        }
    }

    @Test fun metadataLimitsCountEntriesAndCombinedUtf8Bytes() {
        val accept: (String) -> Boolean = { true }
        val names = (1..17).associate { "k$it" to accept }
        val policy = TransferUploadPolicy(listOf(TransferUploadEndpoint(ORIGIN, URL, formFields = names, headers = names)))
        val sixteen = JsonObject().apply { (1..16).forEach { addProperty("k$it", "") } }
        policy.authorize(ORIGIN, params { add("formData", sixteen); add("headers", sixteen) })
        for (map in listOf("formData", "headers")) {
            assertCode(-32006) {
                policy.authorize(ORIGIN, params { add(map, sixteen.deepCopy().apply { addProperty("k17", "") }) })
            }
        }
        val body = "界".repeat(5460)
        fun batch(extra: String) = params {
            add("formData", JsonObject().apply { addProperty("k1", body + extra) })
            add("headers", JsonObject().apply { addProperty("k2", "") })
        }
        policy.authorize(ORIGIN, batch("")) // two 2-byte keys + 16,380 bytes
        assertCode(-32006) { policy.authorize(ORIGIN, batch("x")) }
    }

    @Test fun fieldAndHeaderRulesApplyToNamesAndValuesBeforeCredentialsAreRead() {
        var credentialsRead = 0
        val endpoint = TransferUploadEndpoint(ORIGIN, URL,
            fileFields = setOf("image"), formFields = mapOf("purpose" to { it == "avatar" }),
            headers = mapOf("X-Tag" to { it == "safe" }), maxEdge = 400, maxQuality = 90,
            credentials = { credentialsRead++; mapOf("Authorization" to "Bearer fixture") })
        val policy = TransferUploadPolicy(listOf(endpoint))
        val valid = params {
            addProperty("fieldName", "image")
            add("formData", json("""{"purpose":"avatar"}"""))
            add("headers", json("""{"x-tag":"safe"}"""))
            add("compress", json("""{"maxEdge":400,"quality":90}"""))
        }
        for (override in listOf(
            """{"fieldName":"file"}""", """{"formData":{"other":""}}""", """{"formData":{"purpose":"unknown"}}""",
            """{"headers":{"Other":"ok"}}""", """{"headers":{"x-TAG":"unknown"}}""",
            """{"compress":{"maxEdge":401}}""", """{"compress":{"maxEdge":1,"quality":91}}""",
        )) {
            val denied = valid.deepCopy()
            json(override).entrySet().forEach { denied.getAsJsonObject("request").add(it.key, it.value) }
            assertCode(-32003) { policy.authorize(ORIGIN, denied) }
        }
        val upload = policy.authorize(ORIGIN, valid)
        assertEquals(0, credentialsRead)
        assertEquals("image", upload.fieldName)
        assertEquals(400, upload.maxEdge)
        assertEquals(90, upload.quality)
        assertEquals(mapOf("purpose" to "avatar"), upload.formData)
        val finalHeaders = upload.requestHeaders().mapKeys { it.key.lowercase() }
        assertEquals(mapOf("x-tag" to "safe", "authorization" to "Bearer fixture"), finalHeaders)
        assertEquals(1, credentialsRead)
    }

    @Test fun transportHeadersAndCredentialsBelongToTheHost() {
        val forbidden = listOf("Authorization", "COOKIE", "Host", "Content-Foo", "Transfer-Encoding", "Proxy-Authorization", "Connection")
        val declaredHeaders = (forbidden + "X-Token").associateWith { { _: String -> true } }
        val policy = TransferUploadPolicy(listOf(TransferUploadEndpoint(ORIGIN, URL,
            headers = declaredHeaders, credentials = { mapOf("x-TOKEN" to "host-only") })))
        for (name in forbidden) {
            assertCode(-32003) {
                policy.authorize(ORIGIN, params { add("headers", JsonObject().apply { addProperty(name, "page") }) })
            }
        }
        val collision = policy.authorize(ORIGIN, params { add("headers", json("""{"x-token":"page"}""")) })
        assertCode(-32003) { collision.requestHeaders() }
    }

    @Test fun repeatedRawHeaderNamesAreDetectedOnlyInTheUploadRequestHeaders() {
        fun repeated(headers: String): Boolean {
            val meta = """{"sid":"session","headers":{"x":"first","x":"last"}}"""
            val params = """{"id":"$ID","request":{"headers":$headers,"url":"$URL"}}"""
            val raw = """{"meta":$meta,"rpc":{"params":$params,"method":"transfer.upload@1","id":"call","jsonrpc":"2.0"},"jsb":"1.0"}"""
            return hasRepeatedUploadHeader(raw, json(raw).getAsJsonObject("rpc").getAsJsonObject("params"))
        }
        assertTrue(repeated("""{"X-Tag":"first","X-Tag":"last"}"""))
        assertTrue(repeated("""{"X-Tag":"first","X-\u0054ag":"last"}"""))
        assertFalse(repeated("""{"X-Tag":"one","X-Other":"two"}"""))
        assertFalse(repeated("{}"))
    }

    @Test fun failedHostRulesAndInvalidCredentialHeadersAreSanitized() {
        val rules = TransferUploadPolicy(listOf(TransferUploadEndpoint(ORIGIN, URL,
            formFields = mapOf("tag" to { throw IllegalStateException("private diagnostic") }))))
        val failure = assertThrows(MediaFailure::class.java) {
            rules.authorize(ORIGIN, params { add("formData", json("""{"tag":"note"}""")) })
        }
        assertEquals(-32603, failure.code)
        assertFalse(failure.message.orEmpty().contains("private diagnostic"))
        for (invalid in listOf(mapOf("Authorization" to "bad\nvalue"), mapOf("Host" to "other.example"),
            mapOf("Authorization" to "first", "aUTHORIZATION" to "second"))) {
            val policy = TransferUploadPolicy(listOf(TransferUploadEndpoint(ORIGIN, URL, credentials = { invalid })))
            assertCode(-32603) { policy.authorize(ORIGIN, params()).requestHeaders() }
        }
    }

    private fun params(configure: JsonObject.() -> Unit = {}) = JsonObject().apply {
        addProperty("id", ID)
        add("request", JsonObject().apply { addProperty("url", URL); configure() })
    }

    private fun json(raw: String) = JsonParser.parseString(raw).asJsonObject

    private fun assertCode(code: Int, action: () -> Unit) {
        assertEquals(code, assertThrows(MediaFailure::class.java) { action() }.code)
    }

    private companion object {
        const val ORIGIN = "https://app.example"
        const val URL = "https://upload.example:443/photo"
        const val ID = "0123456789abcdef0123456789abcdef"
    }
}
