package dev.openjsbridge.host

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class TransferUploadSessionTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun handshakeRequiresAnAuthorizedOriginMediaAndCancellableExecution() {
        val fixture = Fixture()
        for (client in listOf(fixture.client(media = false), fixture.client(runner = false), fixture.client(upload = false))) {
            val hello = client.hello()
            assertFalse(hello.getAsJsonObject("capabilities").getAsJsonObject("methods").has(UPLOAD))
            client.upload("unavailable", "0".repeat(32))
            assertEquals(-32601, client.error("unavailable"))
        }
        val other = fixture.client(origin = OTHER)
        val otherHello = other.hello()
        assertFalse(otherHello.getAsJsonObject("capabilities").getAsJsonObject("methods").has(UPLOAD))
        other.upload("denied", "0".repeat(32))
        assertEquals(-32003, other.error("denied"))
        val hello = fixture.client().hello().getAsJsonObject("capabilities")
        assertEquals(obj("""{"versions":[1]}"""), hello.getAsJsonObject("methods").get(UPLOAD))
        assertTrue(hello.getAsJsonArray("features").map { it.asString }.containsAll(listOf("cancel", "callbacks")))
        assertTrue(fixture.requests.isEmpty())
    }

    @Test fun deniedUploadsNeverStartNetworkWork() {
        val fixture = Fixture()
        val page = fixture.client().apply { hello() }
        val second = fixture.client().apply { hello() }
        val handle = page.choose()
        second.upload("foreign", handle)
        assertEquals(-32003, second.error("foreign"))
        page.upload("wrong-path", handle, url = "$ENDPOINT/other")
        assertEquals(-32003, page.error("wrong-path"))
        page.upload("header", handle, fields = ""","headers":{"Authorization":"page"}""")
        assertEquals(-32003, page.error("header"))
        assertEquals("forbidden_header", page.reason("header"))
        page.upload("zero-timeout", handle, timeout = 0)
        assertEquals(-32602, page.error("zero-timeout"))
        fixture.foreground = false
        page.upload("background", handle)
        assertEquals(-32003, page.error("background"))
        fixture.foreground = true
        fixture.confirm = { false }
        page.upload("declined", handle)
        assertEquals(-32007, page.error("declined"))
        fixture.confirm = { true }
        page.release(handle)
        page.upload("released", handle)
        assertEquals(-32003, page.error("released"))
        val expired = page.choose()
        fixture.advance(TTL)
        page.upload("expired", expired)
        assertEquals(-32003, page.error("expired"))
        assertTrue(fixture.requests.isEmpty())
    }

    @Test fun duplicateRequestsAndConcurrentUploadsDoNotRepeatThePost() {
        val fixture = Fixture()
        val page = fixture.client().apply { hello() }
        val handle = page.choose()
        page.upload("first", handle)
        val post = fixture.requests.single()
        assertEquals(mapOf("Authorization" to "Bearer host"), post.credentials)
        assertArrayEquals(JPEG, post.file.readBytes())
        page.upload("first", handle)
        page.upload("busy", handle)
        assertEquals(-32010, page.error("busy"))
        repeat(16) { index ->
            val id = "device-$index"
            page.deviceInfo(id)
            assertEquals(-32008, page.error(id))
        }
        assertEquals(1, fixture.requests.size)
        post.progress(3, 12)
        post.progress(12, 12)
        val progress = page.progress()
        assertEquals(listOf(0, 1), progress.map { it.get("seq").asInt })
        assertEquals(listOf(3, 12), progress.map { it.getAsJsonObject("chunk").get("sent").asInt })
        assertTrue(progress.all { it.get("requestId").asString == "first" && it.getAsJsonObject("chunk").get("total").asInt == 12 })
        val response = obj("""{"status":413,"body":"large"}""")
        post.finish.complete(response)
        assertEquals(response, page.terminal("first").get("result"))
        assertFalse(post.file.exists())
        page.upload("first", handle)
        assertEquals(1, fixture.requests.size)
        assertEquals(1, page.terminals("first").size)
        page.upload("retry", handle)
        assertEquals(2, fixture.requests.size)
        page.cancel("retry")
        assertEquals(-32002, page.error("retry"))
    }

    @Test fun responseBodyWithinTheHttpLimitCanExceedTheWireFrameAfterJsonEscaping() {
        val fixture = Fixture()
        val page = fixture.client().apply { hello() }
        page.upload("escaped", page.choose())
        val post = fixture.requests.single()
        post.finish.complete(JsonObject().apply {
            addProperty("status", 200)
            addProperty("body", "\u0000".repeat(12 * 1024))
        })
        assertEquals(-32006, page.error("escaped"))
        assertEquals("payload_too_large", page.reason("escaped"))
        assertFalse(post.file.exists())
    }

    @Test fun failedTransfersReturnOnlyThePublicErrorAndLeaveTheSourceReusable() {
        val fixture = Fixture()
        val page = fixture.client().apply { hello() }
        val handle = page.choose()
        for ((reason, failure) in listOf(
            "network_failure" to MediaFailure(-32603, "network_failure"),
            "internal_error" to IllegalStateException("Private endpoint credential"),
        )) {
            page.upload(reason, handle)
            val post = fixture.requests.last()
            post.finish.completeExceptionally(failure)
            assertEquals(-32603, page.error(reason))
            assertEquals(reason, page.reason(reason))
            assertEquals("Internal error", page.terminal(reason).getAsJsonObject("error").get("message").asString)
            assertFalse(page.terminal(reason).toString().contains("Private endpoint credential"))
            assertFalse(post.file.exists())
        }
        assertEquals(2, fixture.requests.size)
    }

    @Test fun cancellationOrReleaseBeforeTheEncoderReturnsDeletesItsCompletedFile() {
        for (release in listOf(false, true)) {
            val fixture = Fixture()
            val page = fixture.client().apply { hello() }
            val handle = page.choose()
            lateinit var output: File
            fixture.afterEncoding = { jpeg ->
                output = jpeg
                assertArrayEquals(JPEG, jpeg.readBytes())
                if (release) page.release(handle) else page.cancel("encoding")
            }

            page.upload("encoding", handle)
            assertEquals(if (release) -32003 else -32002, page.error("encoding"))
            assertFalse("The late encoder output must be unlinked", output.exists())
            assertEquals(0, fixture.credentialReads)
            assertTrue(fixture.requests.isEmpty())

            fixture.afterEncoding = {}
            page.upload("retry", handle)
            if (release) {
                assertEquals(-32003, page.error("retry"))
                assertTrue(fixture.requests.isEmpty())
            } else {
                val post = fixture.requests.single()
                post.finish.complete(obj("""{"status":204,"body":""}"""))
                assertEquals(204, page.terminal("retry").getAsJsonObject("result").get("status").asInt)
            }
        }
    }

    @Test fun backgroundAfterBothDeadlinesReportsTheFirstExpiryEvenWhenTimersAreParked() {
        for ((timeout, expectedCode) in listOf((TTL - 100) to -32001, (TTL + 100) to -32003)) {
            val fixture = Fixture()
            val page = fixture.client().apply { hello() }
            page.upload("pending", page.choose(), timeout = timeout)
            val post = fixture.requests.single()
            fixture.advance(TTL + 200, fireTimers = false)
            assertTrue(page.terminals("pending").isEmpty())
            fixture.background()
            fixture.advance(0)
            assertEquals("RPC timeout $timeout", expectedCode, page.error("pending"))
            assertTrue(post.stopped)
            assertFalse(post.file.exists())
        }
    }

    @Test fun releaseDuringUserConfirmationPreventsThePendingPost() {
        val fixture = Fixture()
        val decision = CompletableDeferred<Boolean>()
        fixture.confirm = { decision.await() }
        val page = fixture.client().apply { hello() }
        val handle = page.choose()
        page.upload("confirming", handle)
        page.release(handle)
        decision.complete(true)
        assertEquals(-32003, page.error("confirming"))
        assertTrue(fixture.requests.isEmpty())
    }

    @Test fun backgroundDeadlineReleaseAndExpiryEachSettleOnceAndStopProgress() {
        for (reason in listOf("background", "timeout", "release", "expiry")) {
            val fixture = Fixture()
            val page = fixture.client().apply { hello() }
            val handle = page.choose()
            page.upload("pending", handle, timeout = if (reason == "expiry") TTL + 1 else 500)
            val post = fixture.requests.single()
            val expected = when (reason) {
                "background" -> { fixture.background(); -32002 }
                "timeout" -> { fixture.advance(500); -32001 }
                "release" -> { page.release(handle); -32003 }
                else -> { fixture.advance(TTL); -32003 }
            }
            assertEquals(reason, expected, page.error("pending"))
            assertTrue(reason, post.stopped)
            assertFalse(reason, post.file.exists())
            val before = page.frames.size
            runCatching { post.progress(1, 2) }
            post.finish.complete(obj("""{"status":200,"body":"late"}"""))
            assertEquals(reason, before, page.frames.size)
        }
    }

    @Test fun navigationDropsLateRepliesAndTheNewSessionCanReuseTheRequestIdWithoutCallbacks() {
        val fixture = Fixture()
        val page = fixture.client().apply { hello() }
        val oldSession = page.sid
        val oldHandle = page.choose()
        page.upload("shared", oldHandle)
        val first = fixture.requests.single()
        page.hello(token = "b".repeat(32), callbacks = false)
        assertNotEquals(oldSession, page.sid)
        assertTrue(first.stopped)
        assertFalse(first.file.exists())
        page.upload("stale", oldHandle)
        assertEquals(-32003, page.error("stale"))
        page.upload("shared", page.choose())
        val next = fixture.requests.last()
        assertEquals(2, fixture.requests.size)
        val before = page.frames.size
        runCatching { first.progress(1, 2) }
        first.finish.complete(obj("""{"status":500,"body":"old"}"""))
        next.progress(1, 2)
        assertEquals(before, page.frames.size)
        val response = obj("""{"status":204,"body":""}""")
        next.finish.complete(response)
        assertEquals(response, page.terminal("shared").get("result"))
    }

    private class Post(val file: File, val credentials: Map<String, String>, val progress: (Long, Long) -> Unit) {
        val finish = CompletableDeferred<JsonObject>()
        var stopped = false
    }

    private inner class Fixture {
        private val directory = temporary.newFolder()
        private var clock = 0L
        private val timers = mutableMapOf<() -> Unit, Long>()
        private val onBackground = mutableSetOf<() -> Unit>()
        var foreground = true
        var confirm: suspend () -> Boolean = { true }
        var afterEncoding: (File) -> Unit = {}
        var credentialReads = 0
        val requests = mutableListOf<Post>()

        private val mediaModule = MediaModule(
            pick = { MediaImage({ "image/png" }) { ORIGINAL.inputStream() } }, directory = directory,
            generateThumbnail = { MediaThumbnail(4, 2, JPEG) }, scheduleExpiry = ::schedule,
            epochMillis = { 1_700_000_000_000L + clock }, elapsedMillis = { clock }, io = Dispatchers.Unconfined,
        )
        private val uploadModule = TransferUploadModule(
            policy = TransferUploadPolicy(listOf(TransferUploadEndpoint(ORIGIN, ENDPOINT,
                confirm = { confirm() }, credentials = { credentialReads++; mapOf("Authorization" to "Bearer host") }))),
            isForeground = { foreground },
            observeBackground = { callback -> onBackground.add(callback); { onBackground.remove(callback); Unit } },
            schedule = ::schedule, elapsedMillis = { clock }, io = Dispatchers.Unconfined,
            prepare = { file, output, _, _, check ->
                check()
                assertArrayEquals(ORIGINAL, file.readBytes())
                File.createTempFile("upload-", ".jpg", output).apply { writeBytes(JPEG) }.also(afterEncoding)
            },
            send = { _, credentials, file, check, progress ->
                check()
                val post = Post(file, credentials, progress)
                requests.add(post)
                try { post.finish.await() } finally { post.stopped = true }
            },
        )

        fun client(origin: String = ORIGIN, media: Boolean = true, upload: Boolean = true, runner: Boolean = true) =
            Client(origin, BridgeModules(device = DeviceModule("14"), media = mediaModule.takeIf { media },
                upload = uploadModule.takeIf { upload }), runner)

        private fun schedule(delay: Long, callback: () -> Unit): () -> Unit {
            timers[callback] = clock + delay
            return { timers.remove(callback) }
        }

        fun advance(millis: Long, fireTimers: Boolean = true) {
            clock += millis
            if (!fireTimers) return
            for (callback in timers.filterValues { it <= clock }.keys) {
                if (timers.remove(callback) != null) callback()
            }
        }

        fun background() {
            foreground = false
            onBackground.toList().forEach { it() }
        }
    }

    private class Client(val origin: String, modules: BridgeModules, runner: Boolean) {
        private var proxy = Any()
        private var token = "a".repeat(32)
        private var counter = 0
        var sid = ""; private set
        val frames = mutableListOf<JsonObject>()
        var delayedReplies: MutableList<() -> Unit>? = null
        private val transport = DocumentTransport(listOf(ORIGIN, OTHER), false, modules,
            runBusiness = if (runner) ({ call, finish ->
                val job = CoroutineScope(Dispatchers.Unconfined).launch { finish(runCatching { call.handler() }) }
                ({ job.cancel() })
            }) else null,
            scheduleReply = { action -> delayedReplies?.add(action) ?: action() },
        )

        fun beginCommit() = checkNotNull(transport.onPageCommitVisible("$origin/page")).nonce

        fun confirmCommit(nonce: String, token: String = this.token, replaceProxy: Boolean = false) {
            if (replaceProxy) proxy = Any()
            this.token = token
            transport.receive("commit:$nonce:$token", origin, true, proxy) { assertEquals("ready:$nonce:$token", it) }
        }

        fun hello(token: String = this.token, callbacks: Boolean = true): JsonObject {
            confirmCommit(beginCommit(), token)
            val id = "hello-${counter++}"
            val wants = if (callbacks) """["cancel","callbacks"]""" else """["cancel"]"""
            send("""{"jsonrpc":"2.0","id":"$id","method":"bridge.hello","params":{"protocols":[1],"wants":$wants}}""", null)
            val result = terminal(id).getAsJsonObject("result")
            sid = result.get("sid").asString
            return result
        }

        fun choose(): String {
            val id = "choose-${counter++}"
            send("""{"jsonrpc":"2.0","id":"$id","method":"media.chooseMedia@1"}""")
            return terminal(id).getAsJsonObject("result").getAsJsonArray("files").single().asJsonObject.get("id").asString
        }

        fun release(handle: String) {
            val id = "release-${counter++}"
            send("""{"jsonrpc":"2.0","id":"$id","method":"media.release","params":{"ids":["$handle"]}}""")
            assertTrue(terminal(id).get("result").isJsonNull)
        }

        fun upload(id: String, handle: String, url: String = ENDPOINT, fields: String = "", timeout: Long? = null) {
            send("""{"jsonrpc":"2.0","id":"$id","method":"$UPLOAD@1","params":{"id":"$handle","request":{"url":"$url"$fields}}}""",
                sid, timeout)
        }

        fun cancel(id: String) = send("""{"jsonrpc":"2.0","method":"bridge.cancel","params":{"requestId":"$id"}}""")

        fun deviceInfo(id: String) = send("""{"jsonrpc":"2.0","id":"$id","method":"device.getInfo"}""")

        private fun send(rpc: String, session: String? = sid, timeout: Long? = null) {
            val meta = JsonObject().apply { session?.let { addProperty("sid", it) }; timeout?.let { addProperty("timeout", it) } }
            transport.receive("""rpc:$token:{"jsb":"1.0","meta":$meta,"rpc":$rpc}""", origin, true, proxy) {
                frames.add(obj(it.removePrefix("rpc:$token:")))
            }
        }

        fun progress() = frames.map { it.getAsJsonObject("rpc") }.filter { it.get("method")?.asString == "bridge.progress" }
            .map { it.getAsJsonObject("params") }
        fun terminals(id: String) = frames.map { it.getAsJsonObject("rpc") }.filter { it.get("id")?.asString == id }
        fun terminal(id: String) = terminals(id).single()
        fun error(id: String) = terminal(id).getAsJsonObject("error").get("code").asInt
        fun reason(id: String) = terminal(id).getAsJsonObject("error").getAsJsonObject("data").get("reason").asString
    }

    @Test fun uploadTerminalSurvivesAFullQueueOnlyForTheReconfirmedDocument() {
        for (completeBeforeCommit in listOf(false, true)) {
            for (replacement in listOf("same", "token", "proxy")) {
                val fixture = Fixture()
                val page = fixture.client().apply { hello() }
                page.upload("pending", page.choose())
                val scheduled = mutableListOf<() -> Unit>()
                page.delayedReplies = scheduled
                if (completeBeforeCommit) {
                    fixture.requests.single().finish.complete(obj("""{"status":204,"body":""}"""))
                    assertEquals(1, scheduled.size)
                }
                val challenge = page.beginCommit()
                repeat(9) { page.deviceInfo("parked-$it") }
                page.delayedReplies = null
                scheduled.forEach { it() }
                val before = page.frames.size
                assertTrue(page.terminals("pending").isEmpty())
                when (replacement) {
                    "token" -> page.confirmCommit(challenge, token = "b".repeat(32))
                    "proxy" -> page.confirmCommit(challenge, replaceProxy = true)
                    else -> page.confirmCommit(challenge)
                }
                scheduled.forEach { it() }
                val ids = page.frames.drop(before).map { it.getAsJsonObject("rpc").get("id").asString }
                if (replacement == "same") {
                    assertEquals(listOf("pending") + (0 until 8).map { "parked-$it" }, ids)
                    if (completeBeforeCommit) assertEquals(204, page.terminal("pending").getAsJsonObject("result").get("status").asInt)
                    else assertEquals(-32002, page.error("pending"))
                } else {
                    assertTrue(ids.isEmpty())
                }
            }
        }
    }

    private companion object {
        const val ORIGIN = "https://app.example.test"
        const val OTHER = "https://other.example.test"
        const val ENDPOINT = "https://uploads.example.test/avatar"
        const val UPLOAD = "transfer.upload"
        const val TTL = 300_000L
        val ORIGINAL = byteArrayOf(11, 22, 33)
        val JPEG = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xd9.toByte())
        fun obj(json: String) = JsonParser.parseString(json).asJsonObject
    }
}
