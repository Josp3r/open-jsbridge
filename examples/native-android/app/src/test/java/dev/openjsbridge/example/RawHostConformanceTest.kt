package dev.openjsbridge.example

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.StringReader
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

@RunWith(Parameterized::class)
class RawHostConformanceTest(private val name: String, private val scenario: JsonObject) {
    private class SessionIds(var current: String? = null, var old: String? = null) {
        fun substitute(raw: String, context: String): String = quotedString.replace(raw) { token ->
            when (token.value) {
                "\"$SID\"" -> JsonPrimitive(checkNotNull(current) { "$context: unbound $SID" }).toString()
                "\"$OLD_SID\"" -> JsonPrimitive(checkNotNull(old) { "$context: unbound $OLD_SID" }).toString()
                else -> token.value
            }
        }
    }

    @Test
    fun matchesSharedFixture() {
        val core = RpcSession(enableEcho = true)
        val ids = SessionIds()
        when (val initial = scenario.get("initial").asString) {
            "fresh" -> Unit
            "active" -> ids.current = bootstrap(core, "$name bootstrap")
            "replaced" -> {
                ids.old = bootstrap(RpcSession(enableEcho = true), "$name old bootstrap")
                ids.current = bootstrap(core, "$name current bootstrap")
                assertNotEquals("$name: sessions must have distinct IDs", ids.old, ids.current)
            }
            else -> error("$name: unknown initial state $initial")
        }
        val steps = scenario.getAsJsonArray("steps")
        require(steps.size() > 0) { "$name: no steps" }
        steps.forEachIndexed { index, step ->
            verifyStep(core, ids, step.asJsonObject, "$name step ${index + 1}")
        }
    }

    private fun bootstrap(core: RpcSession, context: String): String {
        val ids = SessionIds()
        verifyStep(core, ids, fixture.getAsJsonObject("bootstrap"), context)
        return checkNotNull(ids.current) { "$context: hello did not bind a SID" }
    }

    private fun verifyStep(core: RpcSession, ids: SessionIds, step: JsonObject, context: String) {
        val raw = ids.substitute(step.get("raw").asString, context)
        val accepted = step.getAsJsonArray("accept").map { it.asJsonObject }
        require(accepted.isNotEmpty()) { "$context: no accepted outcomes" }
        val reply = core.receive(raw)
        val diagnostic = "$context\ninput: $raw\naccepted: $accepted\nreply: ${reply ?: "(no reply)"}"
        if (reply == null) {
            assertTrue(diagnostic, accepted.any { it.get("kind").asString == "none" })
            return
        }

        val envelope = parseObject(reply, diagnostic)
        val rpc = envelope.get("rpc") as? JsonObject ?: throw AssertionError(diagnostic)
        val meta = envelope.get("meta")
        assertTrue(diagnostic, meta == null || meta is JsonObject)
        val sid = (meta as? JsonObject)?.get("sid")
        assertEquals(diagnostic, JsonPrimitive("1.0"), envelope.get("jsb"))
        assertEquals(diagnostic, JsonPrimitive("2.0"), rpc.get("jsonrpc"))
        assertTrue(diagnostic, !rpc.has("method") && rpc.has("result") != rpc.has("error"))

        val outcome = accepted.firstOrNull { matches(it, rpc, sid, ids.current) }
            ?: throw AssertionError(diagnostic)
        if (outcome.get("kind").asString == "hello") {
            ids.current = rpc.getAsJsonObject("result").get("sid").asString
        }
    }

    private fun matches(expect: JsonObject, rpc: JsonObject, sid: JsonElement?, current: String?): Boolean {
        val kind = expect.get("kind").asString
        if (kind == "none" || !expect.has("id") || expect.get("id") != rpc.get("id")) return false
        val expectedSid = expect.get("sid")
        if (kind == "hello") {
            val result = rpc.get("result") as? JsonObject ?: return false
            val negotiated = result.get("sid") as? JsonPrimitive ?: return false
            return expectedSid == JsonPrimitive(SID) && result.get("jsb") == JsonPrimitive("1.0") &&
                negotiated.isString && negotiated.asString.isNotEmpty() &&
                (current == null || negotiated.asString == current) && (sid == null || sid == negotiated)
        }
        val sidMatches = when {
            expectedSid?.isJsonNull == true -> sid == null
            expectedSid == JsonPrimitive(SID) -> current != null && sid == JsonPrimitive(current)
            else -> false
        }
        if (!sidMatches) return false
        return when (kind) {
            "result" -> sameJson(expect.get("value"), rpc.get("result"))
            "error" -> {
                val error = rpc.get("error") as? JsonObject ?: return false
                val message = error.get("message") as? JsonPrimitive ?: return false
                message.isString && sameJson(expect.get("code"), error.get("code")) &&
                    (!expect.has("data") || sameJson(expect.get("data"), error.get("data")))
            }
            else -> false
        }
    }

    companion object {
        private const val SID = "\$SID"
        private const val OLD_SID = "\$OLD_SID"
        private const val FIXTURE_PATH = "/host-inbound-raw.json"
        // Match complete string tokens, without parsing or rewriting the rest of the raw frame.
        private val quotedString = Regex("\"(?:[^\"\\\\]|\\\\.)*+\"", RegexOption.DOT_MATCHES_ALL)
        private val fixture: JsonObject by lazy {
            val stream = checkNotNull(RawHostConformanceTest::class.java.getResourceAsStream(FIXTURE_PATH)) {
                "Missing shared test resource $FIXTURE_PATH"
            }
            parseObject(stream.bufferedReader(Charsets.UTF_8).use { it.readText() }, FIXTURE_PATH)
        }

        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun scenarios(): List<Array<Any>> {
            require(sameJson(JsonPrimitive(1), fixture.get("version"))) { "$FIXTURE_PATH: expected v1 fixture" }
            val cases = fixture.getAsJsonArray("cases")
            require(cases.size() > 0) { "$FIXTURE_PATH: no cases" }
            return cases.map {
                val scenario = it.asJsonObject
                arrayOf<Any>(scenario.get("name").asString, scenario)
            }
        }

        private fun parseObject(raw: String, context: String): JsonObject = try {
            JsonReader(StringReader(raw)).use { reader ->
                reader.strictness = Strictness.STRICT
                val value = JsonParser.parseReader(reader) as JsonObject
                check(reader.peek() == JsonToken.END_DOCUMENT)
                value
            }
        } catch (cause: Exception) {
            throw AssertionError("$context: expected a single JSON object", cause)
        }

        private fun sameJson(expected: JsonElement?, actual: JsonElement?): Boolean {
            if (expected == null || actual == null) return false
            return when {
                expected is JsonObject && actual is JsonObject ->
                    expected.keySet() == actual.keySet() &&
                        expected.entrySet().all { (key, value) -> sameJson(value, actual.get(key)) }
                expected.isJsonArray && actual.isJsonArray -> {
                    val left = expected.asJsonArray
                    val right = actual.asJsonArray
                    left.size() == right.size() && (0 until left.size()).all { sameJson(left[it], right[it]) }
                }
                expected is JsonPrimitive && expected.isNumber && actual is JsonPrimitive && actual.isNumber ->
                    expected.asBigDecimal.compareTo(actual.asBigDecimal) == 0
                else -> expected == actual
            }
        }
    }
}
