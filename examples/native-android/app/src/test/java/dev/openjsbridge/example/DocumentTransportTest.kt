package dev.openjsbridge.example

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class DocumentTransportTest {
    private val transport = DocumentTransport(ORIGIN, enableEcho = true)
    private val proxy = Any()
    private val token = "a".repeat(32)

    @Test
    fun onlyTrustedMainFrameCanConfirmCommit() {
        val challenge = transport.onPageCommitVisible("$ORIGIN/demo")!!
        val confirmation = "commit:$challenge:$token"

        assertNull(transport.receive(confirmation, "http://10.0.2.2:4174", true, proxy))
        assertNull(transport.receive(confirmation, ORIGIN, false, proxy))
        assertNull(transport.receive(frame(token, hello("early")), ORIGIN, true, proxy))
        assertEquals("ready:$challenge:$token", transport.receive(confirmation, ORIGIN, true, proxy))
        assertNull(transport.receive(confirmation, ORIGIN, true, Any()))
        assertNull(transport.receive(frame(token, hello("different-proxy")), ORIGIN, true, Any()))
    }

    @Test
    fun helloAdvertisesEchoAndReusesSessionWithinADocument() {
        activate()
        val first = rpc(hello("first")).getAsJsonObject("result")
        val sid = first.get("sid").asString
        assertEquals("1.0", first.get("jsb").asString)
        assertEquals("android", first.getAsJsonObject("host").get("platform").asString)
        val capabilities = first.getAsJsonObject("capabilities")
        assertEquals(1, capabilities.getAsJsonObject("methods")
            .getAsJsonObject("conformance.echo").getAsJsonArray("versions")[0].asInt)
        assertEquals(0, capabilities.getAsJsonArray("events").size())
        assertEquals(0, capabilities.getAsJsonArray("features").size())
        assertEquals(sid, rpc(hello("retry")).getAsJsonObject("result").get("sid").asString)
        assertNull(deliver(hello("first")))
    }

    @Test
    fun reloadRetiresSessionAndRejectsOldProxyAndChallenge() {
        val previousChallenge = activate()
        val previousSid = sid("first")
        val nextToken = "b".repeat(32)
        val nextProxy = Any()
        val nextChallenge = transport.onPageCommitVisible("$ORIGIN/demo")!!

        assertNull(deliver(request("old", sid = previousSid)))
        assertNull(transport.receive("commit:$previousChallenge:$token", ORIGIN, true, proxy))
        assertEquals("ready:$nextChallenge:$nextToken",
            transport.receive("commit:$nextChallenge:$nextToken", ORIGIN, true, nextProxy))
        assertNull(transport.receive(frame(nextToken, hello("forged")), ORIGIN, true, proxy))
        assertNull(transport.receive(frame(nextToken, request("stale", sid = previousSid)), ORIGIN, true, nextProxy))
        val next = transport.receive(frame(nextToken, hello("first")), ORIGIN, true, nextProxy)!!
        assertNotEquals(previousSid, envelope(next, nextToken).getAsJsonObject("rpc")
            .getAsJsonObject("result").get("sid").asString)
        assertNull(transport.onPageCommitVisible("https://untrusted.test/"))
        assertNull(transport.receive(frame(nextToken, hello("after")), ORIGIN, true, nextProxy))
    }

    @Test
    fun pagehideRetiresTheCurrentRouteEvenBeforeTheNextCommit() {
        activate()
        val previousSid = sid("first")
        assertNull(transport.receive("leave:$token", ORIGIN, true, Any()))
        assertNotNull(deliver(request("still-live", sid = previousSid)))
        assertNull(transport.receive("leave:$token", ORIGIN, true, proxy))
        assertNull(deliver(request("late", sid = previousSid)))
    }

    @Test
    fun confirmingTheSameDocumentAgainPreservesItsActiveSession() {
        activate()
        val sid = sid("first")
        val challenged = transport.onPageCommitVisible("$ORIGIN/same-reply-proxy")!!
        assertNull(deliver(request("waiting", sid = sid)))
        assertEquals("ready:$challenged:$token", transport.receive("commit:$challenged:$token", ORIGIN, true, proxy))
        assertEquals(sid, sid("new-hello"))
        assertNotNull(deliver(request("waiting", sid = sid)))
    }

    @Test
    fun echoReturnsTheObjectWithTheOriginalIdAndDropsDuplicateRequests() {
        activate()
        val sid = sid("hello")
        val call = request("echo", sid = sid, method = "conformance.echo@1", params = """{"text":"你好","nested":[1,null]}""")
        val response = envelope(deliver(call)!!)
        assertEquals(sid, response.getAsJsonObject("meta").get("sid").asString)
        val rpc = response.getAsJsonObject("rpc")
        assertEquals("echo", rpc.get("id").asString)
        assertEquals("你好", rpc.getAsJsonObject("result").get("text").asString)
        assertEquals(2, rpc.getAsJsonObject("result").getAsJsonArray("nested").size())
        assertNull(deliver(call))
        assertNull(deliver(request("echo", sid = sid, params = "[]")))
    }

    @Test
    fun malformedAndUnsupportedRequestsReturnOnlySafeCorrelatedErrors() {
        activate()
        assertError("negotiation", -32004, hello("negotiation", "[2]"))
        assertError("bad-hello", -32602, hello("bad-hello", "[1,1]"))
        assertNull(deliver(request("no-session")))
        val sid = sid("hello")
        assertError("missing-sid", -32009, request("missing-sid"))
        assertError("invalid", -32600, request("invalid", sid = sid, params = "[]"))
        assertError("version", -32601, request("version", sid = sid, method = "conformance.echo@2"))
        assertError("reserved", -32600, request("reserved", sid = sid, method = "rpc.execute"))
        assertNull(deliver(request("invalid", sid = sid)))
        assertNull(deliver(request("bad-sid", sid = "old-session")))
        assertNull(deliver(request(null, sid = sid)))
        assertNull(deliver("""{"jsb":"1.0","meta":{"sid":"$sid"},"rpc":{"jsonrpc":"2.0","id":"response","result":{}}}"""))
        assertNull(deliver("[${request("batch", sid = sid)}]"))
    }

    @Test
    fun dropsUtf8FramesOverTheAdvertisedLimit() {
        activate()
        val hello = rpc(hello("hello")).getAsJsonObject("result")
        val sid = hello.get("sid").asString
        val limit = hello.getAsJsonObject("limits").get("maxMessageBytes").asInt
        val oversized = request("large", sid = sid, params = """{"text":"${"你".repeat(limit / 3)}"}""")
        assertFalse(oversized.length > limit)
        assertNull(deliver(oversized))
        assertNotNull(deliver(request("large", sid = sid)))
    }

    @Test
    fun fullRequestRegistryReportsRateLimitWithoutReplyingToRegisteredDuplicates() {
        activate()
        val sid = sid("hello")
        repeat(4_096) { assertNotNull(deliver(request("echo-$it", sid = sid))) }
        assertNull(deliver(request("echo-0", sid = sid)))
        assertError("at-capacity", -32008, request("at-capacity", sid = sid))
    }

    @Test
    fun echoIsAbsentWhenConformanceMethodsAreDisabled() {
        val host = DocumentTransport(ORIGIN, enableEcho = false)
        val challenge = host.onPageCommitVisible(ORIGIN)!!
        host.receive("commit:$challenge:$token", ORIGIN, true, proxy)
        val reply = host.receive(frame(token, hello("hello")), ORIGIN, true, proxy)!!
        val result = envelope(reply).getAsJsonObject("rpc").getAsJsonObject("result")
        assertEquals(0, result.getAsJsonObject("capabilities").getAsJsonObject("methods").size())
        val echo = host.receive(frame(token, request("echo", sid = result.get("sid").asString)), ORIGIN, true, proxy)!!
        assertEquals(-32601, envelope(echo).getAsJsonObject("rpc").getAsJsonObject("error").get("code").asInt)
    }

    private fun activate(): String {
        val challenge = transport.onPageCommitVisible("$ORIGIN/demo")!!
        assertEquals("ready:$challenge:$token", transport.receive("commit:$challenge:$token", ORIGIN, true, proxy))
        return challenge
    }

    private fun deliver(raw: String) = transport.receive(frame(token, raw), ORIGIN, true, proxy)
    private fun rpc(raw: String) = envelope(deliver(raw)!!).getAsJsonObject("rpc")
    private fun sid(id: String) = rpc(hello(id)).getAsJsonObject("result").get("sid").asString
    private fun frame(token: String, raw: String) = "rpc:$token:$raw"

    private fun envelope(framed: String, token: String = this.token): JsonObject {
        val prefix = "rpc:$token:"
        check(framed.startsWith(prefix))
        return JsonParser.parseString(framed.removePrefix(prefix)).asJsonObject
    }

    private fun assertError(id: String, code: Int, raw: String) {
        val response = rpc(raw)
        assertEquals(id, response.get("id").asString)
        assertEquals(code, response.getAsJsonObject("error").get("code").asInt)
    }

    private fun hello(id: String, protocols: String = "[1]") =
        request(id, method = "bridge.hello", params = """{"protocols":$protocols}""")

    private fun request(
        id: String?,
        sid: String? = null,
        method: String = "conformance.echo",
        params: String = "{}",
    ): String {
        val meta = sid?.let { """"meta":{"sid":"$it"},""" }.orEmpty()
        val rpcId = id?.let { """"id":"$it",""" }.orEmpty()
        return """{"jsb":"1.0",${meta}"rpc":{"jsonrpc":"2.0",${rpcId}"method":"$method","params":$params}}"""
    }

    private companion object {
        const val ORIGIN = "http://10.0.2.2:4173"
    }
}
