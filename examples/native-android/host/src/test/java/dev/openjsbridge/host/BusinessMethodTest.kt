package dev.openjsbridge.host

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BusinessMethodTest {
    @Test
    fun businessNamesRequireAQualifiedBaseOutsideReservedNamespaces() {
        for (name in listOf("acme.getConfig", METHOD, "bridgeApps.getConfig")) {
            assertEquals(name, BusinessMethod(name) { JsonNull.INSTANCE }.name)
        }
        for (name in listOf(
            "", "getConfig", "Acme.getConfig", "acme.GetConfig", "acme..getConfig",
            "acme.getConfig@1", "acme.getConfig\n", "acme.get_config", "acme.功能",
            "bridge.other", "conformance.echo", "ojsb.test", "rpc.test", "device.other",
            "app.other", "ui.other", "storage.other", "network.other", "media.other",
        )) {
            assertThrows(name, IllegalArgumentException::class.java) {
                BusinessMethod(name) { JsonNull.INSTANCE }
            }
        }
    }

    @Test
    fun duplicateBusinessNamesAreRejected() {
        assertThrows(IllegalArgumentException::class.java) {
            RpcSession(false, businessMethods = listOf(
                BusinessMethod(METHOD) { JsonNull.INSTANCE },
                BusinessMethod(METHOD) { JsonPrimitive("duplicate") },
            ))
        }
    }

    @Test
    fun helloAdvertisesBusinessV1AlongsideEnabledNativeMethods() {
        val host = RpcSession(
            enableEcho = false,
            modules = BridgeModules(device = DeviceModule("15")),
            businessMethods = listOf(BusinessMethod(METHOD) { JsonNull.INSTANCE }),
        )
        val result = envelope(host.receive(hello())).getAsJsonObject("rpc").getAsJsonObject("result")
        val methods = result.getAsJsonObject("capabilities").getAsJsonObject("methods")
        assertEquals(
            envelope("""{"device.getInfo":{"versions":[1]},"acme.app.getConfig":{"versions":[1]}}"""),
            methods,
        )
    }

    @Test
    fun oversizedBusinessCapabilitiesAreRejectedWithoutActivatingSession() {
        val name = "acme." + "a".repeat(RpcSession.MAX_MESSAGE_BYTES)
        val host = RpcSession(false, businessMethods = listOf(BusinessMethod(name) { JsonNull.INSTANCE }))
        val raw = checkNotNull(host.receive(hello()))
        assertTrue(raw.toByteArray(Charsets.UTF_8).size <= RpcSession.MAX_MESSAGE_BYTES)
        val reply = envelope(raw)
        assertFalse(reply.has("meta"))
        assertEquals("hello", reply.getAsJsonObject("rpc").get("id").asString)
        assertEquals(-32006, error(raw).get("code").asInt)
        assertNull(host.receive(request(id = "unbound", sid = null)))
    }

    @Test
    fun v1CallsDeferAndPassObjectParamsToTheHandler() = runBlocking {
        val host = createHost { params -> JsonObject().apply { add("input", params) } }
        val sid = establish(host)
        for ((index, method) in listOf(METHOD, "$METHOD@1").withIndex()) {
            val id = "config-$index"
            val params = if (index == 0) null else """{"locale":"中文"}"""
            val call = defer(host, request(id, sid, method, params))
            val result = call.handler(call.params)
            val envelope = envelope(host.finishBusinessCall(call, Result.success(result)))
            assertEquals(sid, envelope.getAsJsonObject("meta").get("sid").asString)
            val reply = envelope.getAsJsonObject("rpc")
            assertEquals(id, reply.get("id").asString)
            assertEquals(envelope(params ?: "{}"), reply.getAsJsonObject("result").get("input"))
        }
    }

    @Test
    fun onlyAdmissibleBusinessV1CallsDispatch() {
        val host = createHost()
        var dispatches = 0
        val dispatch: (RpcSession.BusinessCall) -> Unit = { dispatches++ }
        assertNull(host.receive(request("early", "stale"), onBusinessCall = dispatch))
        val sid = establish(host)
        val first = request("first", sid)
        assertNull(host.receive(first, onBusinessCall = dispatch))
        assertNull(host.receive(first, onBusinessCall = dispatch))
        assertNull(host.receive(request("stale", "stale"), businessBusy = true, onBusinessCall = dispatch))
        val cases = listOf(
            Triple(request("version", sid, "$METHOD@2"), false, -32601),
            Triple(request("busy", sid), true, -32008),
            Triple(request("busy-echo", sid, "conformance.echo"), true, -32008),
            Triple(request("params", sid, params = "[]"), false, -32600),
            Triple(request("no-sid", null), true, -32009),
            Triple(request("timeout", sid, timeout = 0), false, -32602),
        )
        for ((raw, busy, code) in cases) {
            assertEquals(code, error(host.receive(raw, businessBusy = busy, onBusinessCall = dispatch)).get("code").asInt)
        }
        assertEquals(1, dispatches)
        val echo = host.receive(request("echo", sid, "conformance.echo", """{"ping":true}"""))
        assertEquals(envelope("""{"ping":true}"""), envelope(echo).getAsJsonObject("rpc").get("result"))
    }

    @Test
    fun resultErrorsAreSanitizedAndCorrelatedWithinTheWireLimit() {
        val host = createHost()
        val sid = establish(host)
        val cyclic = JsonArray().apply { add(this) }
        val cases: List<Triple<Result<JsonElement>, Int, String>> = listOf(
            Triple(Result.failure(InvalidBusinessParamsException()), -32602, "Invalid params"),
            Triple(Result.failure(IllegalArgumentException("private app data")), -32603, "Internal error"),
            Triple(Result.success(JsonPrimitive(Double.NaN)), -32603, "Internal error"),
            Triple(Result.success(JsonPrimitive(9_007_199_254_740_992L)), -32603, "Internal error"),
            Triple(Result.success(cyclic), -32603, "Internal error"),
            Triple(Result.success(JsonPrimitive("界".repeat(32_768))), -32006, "Payload too large"),
        )
        for ((index, case) in cases.withIndex()) {
            val id = "failure-$index"
            val call = defer(host, request(id, sid))
            val raw = checkNotNull(host.finishBusinessCall(call, case.first))
            assertTrue(raw.toByteArray(Charsets.UTF_8).size <= RpcSession.MAX_MESSAGE_BYTES)
            val envelope = envelope(raw)
            assertEquals(sid, envelope.getAsJsonObject("meta").get("sid").asString)
            assertEquals(id, envelope.getAsJsonObject("rpc").get("id").asString)
            val error = error(raw)
            assertEquals(case.second, error.get("code").asInt)
            assertEquals(case.third, error.get("message").asString)
            assertFalse(error.has("data"))
        }
    }

    @Test
    fun closingAHostDiscardsFulfillmentFromItsRetiredSession() {
        val host = createHost()
        val call = defer(host, request("config", establish(host)))
        host.close()
        assertNull(host.finishBusinessCall(call, Result.success(JsonNull.INSTANCE)))

        val next = createHost()
        val sid = establish(next)
        val current = defer(next, request("config", sid))
        assertNull(next.finishBusinessCall(call, Result.success(JsonNull.INSTANCE)))
        val reply = envelope(next.finishBusinessCall(current, Result.success(JsonNull.INSTANCE)))
        assertEquals(sid, reply.getAsJsonObject("meta").get("sid").asString)
        assertEquals(JsonNull.INSTANCE, reply.getAsJsonObject("rpc").get("result"))
    }

    private fun createHost(handler: suspend (JsonObject) -> JsonElement = { JsonNull.INSTANCE }) =
        RpcSession(true, businessMethods = listOf(BusinessMethod(METHOD, handler)))

    private fun defer(host: RpcSession, raw: String): RpcSession.BusinessCall {
        var call: RpcSession.BusinessCall? = null
        assertNull(host.receive(raw, onBusinessCall = { call = it }))
        return checkNotNull(call)
    }

    private fun establish(host: RpcSession): String =
        envelope(host.receive(hello())).getAsJsonObject("rpc").getAsJsonObject("result").get("sid").asString

    private fun hello() =
        """{"jsb":"1.0","rpc":{"jsonrpc":"2.0","id":"hello","method":"bridge.hello","params":{"protocols":[1]}}}"""

    private fun request(
        id: String,
        sid: String?,
        method: String = METHOD,
        params: String? = null,
        timeout: Int? = null,
    ): String {
        val meta = sid?.let {
            val timeoutField = timeout?.let { value -> ""","timeout":$value""" } ?: ""
            """"meta":{"sid":"$it"$timeoutField},"""
        } ?: ""
        val paramsField = params?.let { ""","params":$it""" } ?: ""
        return """{"jsb":"1.0",$meta"rpc":{"jsonrpc":"2.0","id":"$id","method":"$method"$paramsField}}"""
    }

    private fun envelope(raw: String?) = JsonParser.parseString(checkNotNull(raw)).asJsonObject
    private fun error(raw: String?) = envelope(raw).getAsJsonObject("rpc").getAsJsonObject("error")

    private companion object {
        const val METHOD = "acme.app.getConfig"
    }
}
