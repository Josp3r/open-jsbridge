package dev.openjsbridge.host

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DocumentTransportTest {
    private val transport = DocumentTransport(listOf(ORIGIN), enableEcho = true)
    private val proxy = Any()
    private val token = "a".repeat(32)

    @Test
    fun onlyTrustedMainFrameCanConfirmCommit() {
        val challenge = transport.onPageCommitVisible("$ORIGIN/demo")!!.nonce
        val confirmation = "commit:$challenge:$token"

        assertNull(transport.exchange(confirmation, "https://10.0.2.2:4174", true, proxy))
        assertNull(transport.exchange(confirmation, "http://10.0.2.2:4173", true, proxy))
        assertNull(transport.exchange(confirmation, ORIGIN, false, proxy))
        assertNull(transport.exchange(frame(token, hello("early")), ORIGIN, true, proxy))
        assertEquals("ready:$challenge:$token", transport.exchange(confirmation, ORIGIN, true, proxy))
        assertNull(transport.exchange(confirmation, ORIGIN, true, Any()))
        assertNull(transport.exchange(frame(token, hello("different-proxy")), ORIGIN, true, Any()))
    }

    @Test
    fun allowlistedOriginsNeverShareAChallengeProxyOrSession() {
        val first = "https://first.example.test"
        val second = "https://second.example.test:8443"
        val excluded = "https://second.example.test"
        val origins = DocumentTransport.exactOrigins(listOf("HTTPS://FIRST.EXAMPLE.TEST:443/", second))
        val host = DocumentTransport(origins, enableEcho = true)
        fun helloAt(origin: String, id: String): String {
            val response = host.exchange(frame(token, hello(id)), origin, true, proxy)!!
            return envelope(response).getAsJsonObject("rpc").getAsJsonObject("result").get("sid").asString
        }

        val firstChallenge = host.onPageCommitVisible("$first/old")!!
        assertEquals(first, firstChallenge.origin)
        val firstCommit = "commit:${firstChallenge.nonce}:$token"
        assertNull(host.exchange(firstCommit, second, true, proxy))
        assertEquals("ready:${firstChallenge.nonce}:$token", host.exchange(firstCommit, first, true, proxy))
        val oldSid = helloAt(first, "first")

        val nextChallenge = host.onPageCommitVisible("$second/new")!!
        assertEquals(second, nextChallenge.origin)
        val nextCommit = "commit:${nextChallenge.nonce}:$token"
        assertNull(host.exchange(nextCommit, excluded, true, proxy))
        assertNull(host.exchange(nextCommit, first, true, proxy))
        assertNull(host.exchange(nextCommit, second, false, proxy))
        assertNull(host.exchange(frame(token, request("before-confirm", oldSid)), first, true, proxy))
        assertEquals("ready:${nextChallenge.nonce}:$token", host.exchange(nextCommit, second, true, proxy))
        assertNull(host.exchange(frame(token, request("different-origin", oldSid)), first, true, proxy))
        assertNull(host.exchange(frame(token, request("old-sid", oldSid)), second, true, proxy))
        val newSid = helloAt(second, "first")
        assertNotEquals(oldSid, newSid)
        assertNull(host.exchange(frame(token, request("active-sid-wrong-origin", newSid)), first, true, proxy))
        assertNotNull(host.exchange(frame(token, request("active", newSid)), second, true, proxy))

        val delayed = host.onPageCommitVisible("$first/delayed", currentUrl = "$second/new")!!
        assertEquals(second, delayed.origin)
        assertEquals("ready:${delayed.nonce}:$token", host.exchange("commit:${delayed.nonce}:$token", second, true, proxy))
        assertEquals(newSid, helloAt(second, "reconfirm"))

        assertNull(host.onPageCommitVisible("$excluded/unlisted"))
        assertNull(host.exchange(frame(token, request("retired", newSid)), second, true, proxy))
    }

    @Test
    fun exactOriginUsesBrowserSerializationForDefaultPortsAndNumericHosts() {
        assertEquals("https://example.test", DocumentTransport.exactOrigin("HTTPS://EXAMPLE.TEST:443/"))
        assertEquals("https://127.0.0.1:8443", DocumentTransport.exactOrigin("https://127.0.0.1:8443"))
        assertEquals("https://[2001:db8::1]:8443",
            DocumentTransport.exactOrigin("https://[2001:0DB8:0:0:0:0:0:1]:8443/"))
        assertEquals("https://[::ffff:c000:201]", DocumentTransport.exactOrigin("https://[::ffff:192.0.2.1]"))
    }

    @Test
    fun rejectsInvalidAndAmbiguousOrigins() {
        for (origin in listOf("http://example.test", "HTTP://example.test:443/", "https:/path", "https:opaque", "https://example.test:",
            "https://127.001.0.1", "https://127.0.0.1.", "https://0x7f000001", "https://[fe80::1%25eth0]")) {
            assertNull(origin, DocumentTransport.exactOrigin(origin))
        }
    }

    @Test
    fun canonicalDebugOriginCanConfirmItsDocument() {
        val debugOrigin = "http://10.0.2.2:4173"
        val host = DocumentTransport(listOf(debugOrigin), enableEcho = true)
        val challenge = host.onPageCommitVisible("$debugOrigin/demo")!!.nonce
        val confirmation = "commit:$challenge:$token"
        assertNull(host.exchange(confirmation, "http://10.0.2.2:4174", true, proxy))
        assertEquals("ready:$challenge:$token", host.exchange(confirmation, debugOrigin, true, proxy))
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
        val nextChallenge = transport.onPageCommitVisible("$ORIGIN/demo")!!.nonce

        val oldReplies = mutableListOf<String>()
        transport.receive(frame(token, request("old", sid = previousSid)), ORIGIN, true, proxy) {
            oldReplies.add(it)
        }
        assertEquals(emptyList<String>(), oldReplies)
        assertNull(transport.exchange("commit:$previousChallenge:$token", ORIGIN, true, proxy))
        assertEquals("ready:$nextChallenge:$nextToken",
            transport.exchange("commit:$nextChallenge:$nextToken", ORIGIN, true, nextProxy))
        assertEquals(emptyList<String>(), oldReplies)
        assertNull(transport.exchange(frame(nextToken, hello("forged")), ORIGIN, true, proxy))
        assertNull(transport.exchange(frame(nextToken, request("stale", sid = previousSid)), ORIGIN, true, nextProxy))
        val next = transport.exchange(frame(nextToken, hello("first")), ORIGIN, true, nextProxy)!!
        assertNotEquals(previousSid, envelope(next, nextToken).getAsJsonObject("rpc")
            .getAsJsonObject("result").get("sid").asString)
        assertNull(transport.onPageCommitVisible("https://untrusted.test/"))
        assertNull(transport.exchange(frame(nextToken, hello("after")), ORIGIN, true, nextProxy))
    }

    @Test
    fun pagehideRetiresTheCurrentRouteEvenBeforeTheNextCommit() {
        activate()
        val previousSid = sid("first")
        assertNull(transport.exchange("leave:$token", ORIGIN, true, Any()))
        assertNotNull(deliver(request("still-live", sid = previousSid)))
        assertNull(transport.exchange("leave:$token", ORIGIN, true, proxy))
        assertNull(deliver(request("late", sid = previousSid)))
    }

    @Test
    fun supersedingAChallengePreservesRequestsForTheSameConfirmedDocument() {
        activate()
        val sid = sid("first")
        val firstChallenge = transport.onPageCommitVisible("$ORIGIN/same-reply-proxy")!!.nonce
        val call = request("waiting", sid = sid)
        val replies = mutableListOf<String>()
        transport.receive(frame(token, call), ORIGIN, true, proxy) { replies.add(it) }
        val nextChallenge = transport.onPageCommitVisible("$ORIGIN/same-reply-proxy")!!.nonce
        transport.receive(frame(token, call), ORIGIN, true, proxy) { replies.add(it) }
        transport.receive(frame(token, request("next", sid = sid)), ORIGIN, true, proxy) { replies.add(it) }

        assertNull(transport.exchange("commit:$firstChallenge:$token", ORIGIN, true, proxy))
        assertEquals(emptyList<String>(), replies)
        assertEquals("ready:$nextChallenge:$token", transport.exchange("commit:$nextChallenge:$token", ORIGIN, true, proxy))
        assertEquals(listOf("waiting", "next"), replies.map { envelope(it).getAsJsonObject("rpc").get("id").asString })
        assertEquals(sid, sid("new-hello"))
        assertNull(deliver(call))
    }

    @Test
    fun delayedUnlistedCommitUsesTheCurrentUrlOnlyAsAChallengeHint() {
        activate()
        val sid = sid("hello")
        val unlisted = "https://untrusted.test/"
        val challenge = transport.onPageCommitVisible(unlisted, currentUrl = "$ORIGIN/current")!!.nonce
        val confirmation = "commit:$challenge:$token"
        assertNull(transport.exchange(confirmation, unlisted, true, proxy))
        assertEquals("ready:$challenge:$token", transport.exchange(confirmation, ORIGIN, true, proxy))
        assertEquals(sid, sid("still-current"))
    }

    @Test
    fun keepsTheUnconfirmedDocumentQueueBounded() {
        activate()
        val sid = sid("hello")
        val challenge = transport.onPageCommitVisible(ORIGIN)!!.nonce
        val replies = mutableListOf<String>()
        repeat(9) { index ->
            transport.receive(frame(token, request("call-$index", sid = sid)), ORIGIN, true, proxy) {
                replies.add(it)
            }
        }
        assertEquals(emptyList<String>(), replies)
        transport.exchange("commit:$challenge:$token", ORIGIN, true, proxy)
        assertEquals((0 until 8).map { "call-$it" },
            replies.map { envelope(it).getAsJsonObject("rpc").get("id").asString })
        assertNotNull(deliver(request("call-8", sid = sid)))
    }

    @Test
    fun deferredCompletionFromThePreviousDocumentNeverPostsToAProxy() {
        val completions = ArrayDeque<() -> Unit>()
        val host = DocumentTransport(listOf(ORIGIN), enableEcho = true) { completions.addLast(it) }
        val challenge = host.onPageCommitVisible(ORIGIN)!!.nonce
        host.exchange("commit:$challenge:$token", ORIGIN, true, proxy)
        val oldReplies = mutableListOf<String>()
        host.receive(frame(token, hello("hello")), ORIGIN, true, proxy) { oldReplies.add(it) }
        completions.removeFirst()()
        val oldSid = envelope(oldReplies.removeAt(0)).getAsJsonObject("rpc").getAsJsonObject("result").get("sid").asString
        host.receive(frame(token, request("old", sid = oldSid)), ORIGIN, true, proxy) { oldReplies.add(it) }
        val oldEcho = completions.removeFirst()

        val nextToken = "b".repeat(32)
        val nextChallenge = host.onPageCommitVisible(ORIGIN)!!.nonce
        host.exchange("commit:$nextChallenge:$nextToken", ORIGIN, true, proxy)
        oldEcho()
        assertEquals(emptyList<String>(), oldReplies)

        val newReplies = mutableListOf<String>()
        host.receive(frame(nextToken, hello("hello")), ORIGIN, true, proxy) { newReplies.add(it) }
        val newHello = completions.removeFirst()
        newHello()
        newHello()
        val nextSid = envelope(newReplies.single(), nextToken).getAsJsonObject("rpc")
            .getAsJsonObject("result").get("sid").asString
        assertNotEquals(oldSid, nextSid)
    }

    @Test
    fun businessCompletionWaitsForConfirmationOfTheOriginalDocument() {
        val runner = PendingBusiness()
        val host = runner.host()
        val sid = host.confirmAndGetSid()
        val replies = mutableListOf<String>()
        host.receive(frame(token, request("config", sid, method = BUSINESS_METHOD)), ORIGIN, true, proxy) {
            replies.add(it)
        }
        val complete = runner.completions.single()
        val challenge = host.onPageCommitVisible(ORIGIN)!!.nonce

        complete(Result.success(JsonPrimitive("system")))
        assertEquals(emptyList<String>(), replies)
        assertEquals("ready:$challenge:$token", host.exchange("commit:$challenge:$token", ORIGIN, true, proxy))
        complete(Result.success(JsonPrimitive("duplicate")))

        val response = envelope(replies.single())
        assertEquals(sid, response.getAsJsonObject("meta").get("sid").asString)
        assertEquals("config", response.getAsJsonObject("rpc").get("id").asString)
        assertEquals("system", response.getAsJsonObject("rpc").get("result").asString)
    }

    @Test
    fun replacingTheDocumentCancelsThePendingBusinessCall() {
        val runner = PendingBusiness()
        val host = runner.host()
        val oldSid = host.confirmAndGetSid()
        val oldReplies = mutableListOf<String>()
        host.receive(frame(token, request("config", oldSid, method = BUSINESS_METHOD)), ORIGIN, true, proxy) {
            oldReplies.add(it)
        }

        val nextToken = "b".repeat(32)
        val nextProxy = Any()
        val nextSid = host.confirmAndGetSid(nextToken, nextProxy)
        assertNotEquals(oldSid, nextSid)
        assertEquals(1, runner.cancellations)
        runner.completions.removeFirst()(Result.success(JsonPrimitive("old")))
        assertEquals(emptyList<String>(), oldReplies)

        val newReplies = mutableListOf<String>()
        host.receive(frame(nextToken, request("config", nextSid, method = BUSINESS_METHOD)), ORIGIN, true, nextProxy) {
            newReplies.add(it)
        }
        runner.completions.single()(Result.success(JsonPrimitive("new")))
        val response = envelope(newReplies.single(), nextToken)
        assertEquals(nextSid, response.getAsJsonObject("meta").get("sid").asString)
        assertEquals("new", response.getAsJsonObject("rpc").get("result").asString)
        assertEquals(emptyList<String>(), oldReplies)
    }

    @Test
    fun cancellingBusinessWorkFreesTheSlotBeforeReplyAndSuppressesLateCompletion() {
        val scheduled = ArrayDeque<() -> Unit>()
        var deferReplies = false
        val runner = PendingBusiness()
        val host = runner.host { reply ->
            if (deferReplies) scheduled.addLast(reply) else reply()
        }
        val sid = host.confirmAndGetSid()
        val originalReplies = mutableListOf<String>()
        host.receive(frame(token, request("config", sid, method = BUSINESS_METHOD)), ORIGIN, true, proxy) {
            originalReplies.add(it)
        }
        val busy = host.exchange(frame(token, request("busy", sid, method = BUSINESS_METHOD)), ORIGIN, true, proxy)!!
        assertEquals(-32008, envelope(busy).getAsJsonObject("rpc").getAsJsonObject("error").get("code").asInt)

        deferReplies = true
        val notificationReplies = mutableListOf<String>()
        host.receive(frame(token, cancel(sid, "config")), ORIGIN, true, proxy) { notificationReplies.add(it) }
        assertEquals(1, runner.cancellations)
        assertEquals(1, scheduled.size)
        assertTrue(originalReplies.isEmpty())

        val nextReplies = mutableListOf<String>()
        host.receive(frame(token, request("next", sid, method = BUSINESS_METHOD)), ORIGIN, true, proxy) {
            nextReplies.add(it)
        }
        assertEquals(2, runner.completions.size)
        host.receive(frame(token, cancel(sid, "config")), ORIGIN, true, proxy) { notificationReplies.add(it) }
        assertEquals(1, runner.cancellations)
        runner.completions.removeFirst()(Result.success(JsonPrimitive("late")))
        assertEquals(1, scheduled.size)
        runner.completions.removeFirst()(Result.success(JsonPrimitive("system")))
        assertEquals(2, scheduled.size)

        scheduled.removeFirst().invoke()
        scheduled.removeFirst().invoke()
        assertTrue(notificationReplies.isEmpty())
        val cancelled = envelope(originalReplies.single())
        assertEquals(sid, cancelled.getAsJsonObject("meta").get("sid").asString)
        assertEquals("config", cancelled.getAsJsonObject("rpc").get("id").asString)
        assertEquals(-32002, cancelled.getAsJsonObject("rpc").getAsJsonObject("error").get("code").asInt)
        assertEquals("system", envelope(nextReplies.single()).getAsJsonObject("rpc").get("result").asString)
    }

    @Test
    fun ignoresInvalidCancelNotificationsAndStaleSessionWithAReusedRequestId() {
        val runner = PendingBusiness()
        val host = runner.host()
        val oldSid = host.confirmAndGetSid()
        val oldRequest = request("config", oldSid, method = BUSINESS_METHOD)
        assertNull(host.exchange(frame(token, oldRequest), ORIGIN, true, proxy))
        runner.completions.removeFirst()(Result.success(JsonPrimitive("old")))
        val nextToken = "b".repeat(32)
        val nextProxy = Any()
        val sid = host.confirmAndGetSid(nextToken, nextProxy)
        val originalReplies = mutableListOf<String>()
        host.receive(frame(nextToken, request("config", sid, method = BUSINESS_METHOD)), ORIGIN, true, nextProxy) {
            originalReplies.add(it)
        }

        val notifications = listOf(
            cancel(oldSid, "config"),
            cancel(null, "config"),
            cancel(sid, "missing"),
            cancel(sid, ""),
            request(null, sid, method = "bridge.cancel", params = """{"requestId":"config","reason":1}"""),
            request(null, sid, method = "bridge.cancel", params = """{"requestId":true}"""),
            cancel(sid, "config").replace(""""method":""", """"id":null,"method":"""),
        )
        for (raw in notifications) {
            assertNull(host.exchange(frame(nextToken, raw), ORIGIN, true, nextProxy))
        }
        assertNull(host.exchange(frame(nextToken, cancel(sid, "config")), ORIGIN, false, nextProxy))
        assertNull(host.exchange(frame(nextToken, cancel(sid, "config")), ORIGIN, true, proxy))
        assertEquals(0, runner.cancellations)
        assertTrue(originalReplies.isEmpty())

        assertNull(host.exchange(frame(nextToken, cancel(sid, "config", "bridge.cancel@1")), ORIGIN, true, nextProxy))
        assertEquals(1, runner.cancellations)
        assertEquals(-32002, envelope(originalReplies.single(), nextToken)
            .getAsJsonObject("rpc").getAsJsonObject("error").get("code").asInt)
    }

    @Test
    fun cancelControlsRejectRequestsWithIds() {
        val runner = PendingBusiness()
        val host = runner.host()
        val sid = host.confirmAndGetSid()
        for ((index, method) in listOf("bridge.cancel", "bridge.cancel@1").withIndex()) {
            val id = "cancel-$index"
            val req = request(id, sid, method, """{"requestId":"config"}""")
            val response = envelope(host.exchange(frame(token, req), ORIGIN, true, proxy)!!)
                .getAsJsonObject("rpc")
            assertEquals(id, response.get("id").asString)
            assertEquals(-32600, response.getAsJsonObject("error").get("code").asInt)
        }
        assertEquals(0, runner.cancellations)
    }

    @Test
    fun pagehideAndInvalidationCancelBusinessWorkOnce() {
        val runner = PendingBusiness()
        val host = runner.host()
        val sid = host.confirmAndGetSid()
        val replies = mutableListOf<String>()
        host.receive(frame(token, request("config", sid, method = BUSINESS_METHOD)), ORIGIN, true, proxy) {
            replies.add(it)
        }

        host.exchange("leave:$token", ORIGIN, true, proxy)
        assertEquals(1, runner.cancellations)
        host.invalidate()
        runner.completions.single()(Result.success(JsonPrimitive("late")))
        assertEquals(1, runner.cancellations)
        assertEquals(emptyList<String>(), replies)
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
        val host = DocumentTransport(listOf(ORIGIN), enableEcho = false)
        val challenge = host.onPageCommitVisible(ORIGIN)!!.nonce
        host.exchange("commit:$challenge:$token", ORIGIN, true, proxy)
        val reply = host.exchange(frame(token, hello("hello")), ORIGIN, true, proxy)!!
        val result = envelope(reply).getAsJsonObject("rpc").getAsJsonObject("result")
        assertEquals(0, result.getAsJsonObject("capabilities").getAsJsonObject("methods").size())
        val echo = host.exchange(frame(token, request("echo", sid = result.get("sid").asString)), ORIGIN, true, proxy)!!
        assertEquals(-32601, envelope(echo).getAsJsonObject("rpc").getAsJsonObject("error").get("code").asInt)
    }

    private fun activate(): String {
        val challenge = transport.onPageCommitVisible("$ORIGIN/demo")!!.nonce
        assertEquals("ready:$challenge:$token", transport.exchange("commit:$challenge:$token", ORIGIN, true, proxy))
        return challenge
    }

    private fun DocumentTransport.confirmAndGetSid(documentToken: String = token, documentProxy: Any = proxy): String {
        val challenge = onPageCommitVisible(ORIGIN)!!.nonce
        assertEquals("ready:$challenge:$documentToken",
            exchange("commit:$challenge:$documentToken", ORIGIN, true, documentProxy))
        val response = exchange(frame(documentToken, hello("hello")), ORIGIN, true, documentProxy)!!
        return envelope(response, documentToken).getAsJsonObject("rpc").getAsJsonObject("result").get("sid").asString
    }

    private class PendingBusiness {
        val completions = ArrayDeque<(Result<JsonElement>) -> Unit>()
        var cancellations = 0

        fun host(scheduleReply: (() -> Unit) -> Unit = { it() }) = DocumentTransport(
            listOf(ORIGIN),
            enableEcho = false,
            businessMethods = listOf(BusinessMethod(BUSINESS_METHOD) { JsonPrimitive("system") }),
            runBusiness = { _, complete ->
                completions.addLast(complete)
                ({ cancellations += 1 })
            },
            scheduleReply = scheduleReply,
        )
    }

    private fun DocumentTransport.exchange(raw: String, origin: String, isMainFrame: Boolean, proxy: Any): String? {
        val replies = mutableListOf<String>()
        receive(raw, origin, isMainFrame, proxy) { replies.add(it) }
        return if (replies.isEmpty()) null else replies.single()
    }

    private fun deliver(raw: String) = transport.exchange(frame(token, raw), ORIGIN, true, proxy)
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

    private fun cancel(sid: String?, id: String, method: String = "bridge.cancel") =
        request(null, sid, method, params = """{"requestId":"$id"}""")

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
        const val ORIGIN = "https://10.0.2.2:4173"
        const val BUSINESS_METHOD = "acme.app.getConfig"
    }
}
