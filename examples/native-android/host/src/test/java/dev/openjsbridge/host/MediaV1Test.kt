package dev.openjsbridge.host

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.InputStream
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

class MediaV1Test {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun advertisesMediaOnlyWithAUsablePresenterAndAsyncRunner() {
        val disabled = Client()
        val withoutRunner = Client(Fixture().module, async = false)
        for (client in listOf(disabled, withoutRunner)) {
            val hello = client.confirm()
            val capabilities = hello.getAsJsonObject("capabilities")
            assertTrue(capabilities.getAsJsonObject("methods").keySet().intersect(METHODS).isEmpty())
            assertEquals("[]", capabilities.getAsJsonArray("features").toString())
            assertEquals(65_536, hello.limit())
            assertEquals(-32601, client.call(CHOOSE).errorCode())
            assertEquals(-32601, client.call(READ, readParams(UNKNOWN, 0)).errorCode())
            assertEquals(-32601, client.call(RELEASE, refParams(UNKNOWN)).errorCode())
        }

        val client = Client(Fixture().module)
        val hello = client.confirm()
        val capabilities = hello.getAsJsonObject("capabilities")
        for (name in METHODS) {
            assertEquals(obj("""{"versions":[1]}"""), capabilities.getAsJsonObject("methods").get(name))
        }
        assertEquals(setOf("blob", "cancel"), capabilities.getAsJsonArray("features").map { it.asString }.toSet())
        assertTrue("Full 64 KiB base64 plus envelope must fit", hello.limit() >= 88_000)
        for (name in METHODS) assertEquals(-32601, client.call("$name@2").errorCode())
    }

    @Test fun chooseParamsAreStrictAndSystemDismissalIsASuccess() {
        val fixture = Fixture()
        val client = Client(fixture.module)
        client.confirm()
        for (params in listOf("null", "[]", "1", """{"count":9007199254740992}""")) {
            assertEquals(params, -32600, client.call(CHOOSE, params).errorCode())
        }
        for (params in listOf(
            """{"mediaType":"image"}""", """{"mediaType":[]}""",
            """{"mediaType":["image","image"]}""", """{"mediaType":["video"]}""",
            """{"sourceType":["camera"]}""", """{"sourceType":null}""", """{"count":"1"}""",
            """{"count":2}""", """{"count":1.25}""",
            """{"unexpected":null}""",
        )) {
            assertEquals(params, -32602, client.call(CHOOSE, params).errorCode())
        }
        assertEquals(0, fixture.picks)
        val cancelled = obj("""{"status":"cancelled","files":[]}""")
        assertEquals(cancelled, client.call(CHOOSE).result())
        assertEquals(cancelled, client.call("$CHOOSE@1", "{}").result())
        assertEquals(cancelled, client.call(CHOOSE, """{"mediaType":["image"],"sourceType":["album"],"count":1}""").result())
        assertEquals(3, fixture.picks)
        assertEquals(0, fixture.fileCount())
    }

    @Test fun readsExactly64KibPerChunkAndReleaseIsIdempotent() {
        val fixture = Fixture()
        val data = ByteArray(CHUNK + 13) { ((it * 17) % 251).toByte() }
        fixture.next = { MediaImage({ "image/png" }) { data.inputStream() } }
        val client = Client(fixture.module)
        val maxMessageBytes = client.confirm().limit()
        val file = client.call(CHOOSE).selectedFile()
        val ref = file.ref()
        assertTrue(ref.matches(Regex("[0-9a-f]{32}")))
        assertEquals("image", file.get("type").asString)
        assertEquals("image/png", file.get("mime").asString)
        assertEquals(data.size, file.get("size").asInt)
        assertEquals(fixture.epoch + TTL, file.get("expiresAt").asLong)
        assertEquals(setOf("type", "blobRef", "mime", "size", "expiresAt"), file.keySet())
        assertEquals(1, fixture.fileCount())

        val first = client.call("$READ@1", readParams(ref, 0)).result()
        assertArrayEquals(data.copyOfRange(0, CHUNK), first.bytes())
        assertFalse(first.get("done").asBoolean)
        assertTrue(first.toString().length < maxMessageBytes)
        val last = client.call(READ, readParams(ref, 1)).result()
        assertArrayEquals(data.copyOfRange(CHUNK, data.size), last.bytes())
        assertTrue(last.get("done").asBoolean)
        assertEquals(first, client.call(READ, readParams(ref, 0)).result())
        assertEquals(-32602, client.call(READ, readParams(ref, 2)).errorCode())
        for (params in listOf(null, "{}", readParams("A".repeat(32), 0), readParams(ref, -1),
            """{"blobRef":"$ref","index":"0"}""", """{"blobRef":"$ref","index":1.5}""",
            """{"blobRef":"$ref","index":0,"extra":true}""", readParams(UNKNOWN, 320),
        )) assertEquals(params, -32602, client.call(READ, params).errorCode())
        assertEquals(-32600, client.call(READ, "null").errorCode())
        assertEquals(-32600, client.call(READ, """{"blobRef":"$ref","index":9007199254740992}""").errorCode())
        assertEquals(-32600, client.call(RELEASE, "[]").errorCode())
        for (params in listOf(null, "{}", refParams("short"), """{"blobRef":"$ref","index":0}""")) {
            assertEquals(params, -32602, client.call(RELEASE, params).errorCode())
        }
        assertEquals(-32003, client.call(READ, readParams(UNKNOWN, 0)).errorCode())
        repeat(2) { assertEquals(JsonObject(), client.call("$RELEASE@1", refParams(ref)).result()) }
        assertEquals(0, fixture.fileCount())
        assertEquals(-32003, client.call(READ, readParams(ref, 0)).errorCode())
    }

    @Test fun enforcesStreamAndSessionQuotaAndNeverKeepsRejectedFiles() {
        val fixture = Fixture()
        val client = Client(fixture.module)
        client.confirm()
        fixture.image(LIMIT - 1)
        val ref = client.call(CHOOSE).selectedFile().ref()
        assertEquals(1, fixture.fileCount())
        fixture.image(2)
        assertEquals(-32006, client.call(CHOOSE).errorCode())
        assertEquals(1, fixture.fileCount())
        client.call(RELEASE, refParams(ref)).result()
        fixture.image(LIMIT + 1)
        assertEquals(-32006, client.call(CHOOSE).errorCode())
        assertEquals(0, fixture.fileCount())
        fixture.image(0)
        assertEquals(-32603, client.call(CHOOSE).errorCode())
        fixture.image(4, "text/plain")
        assertEquals(-32603, client.call(CHOOSE).errorCode())
        fixture.image(4, "image/" + "a".repeat(123))
        assertEquals(-32603, client.call(CHOOSE).errorCode())
        assertEquals(0, fixture.fileCount())
        fixture.image(LIMIT)
        assertEquals(LIMIT, client.call(CHOOSE).selectedFile().get("size").asInt)
        client.transport.invalidate()
        assertEquals(0, fixture.fileCount())
    }

    @Test fun expiresAndUnlinksEvenWithoutAPollAndRefusesReadsBeforeTimerDispatch() {
        val fixture = Fixture().apply { image(5) }
        val client = Client(fixture.module)
        client.confirm()
        val ref = client.call(CHOOSE).selectedFile().ref()
        fixture.advance(TTL - 1)
        assertEquals(1, fixture.fileCount())
        assertTrue(client.call(READ, readParams(ref, 0)).result().get("done").asBoolean)
        fixture.advance(1)
        assertEquals(0, fixture.fileCount())
        assertEquals(-32003, client.call(READ, readParams(ref, 0)).errorCode())
        assertEquals(JsonObject(), client.call(RELEASE, refParams(ref)).result())
        val newRef = client.call(CHOOSE).selectedFile().ref()
        assertNotEquals(ref, newRef)
        fixture.advance(TTL, fireTimers = false)
        assertEquals(-32003, client.call(READ, readParams(newRef, 0)).errorCode())
        assertEquals(0, fixture.fileCount())
    }

    @Test fun filtersOriginFrameProxyAndKeepsReferencesInTheirDocumentOnly() {
        val fixture = Fixture().apply { image(4) }
        val client = Client(fixture.module)
        client.confirm()
        val sid = client.sid
        val token = client.token
        val ref = client.call(CHOOSE).selectedFile().ref()
        val valid = client.request("invalid", READ, readParams(ref, 0))
        assertNull(client.send(valid, origin = "$ORIGIN:8080"))
        assertNull(client.send(valid, main = false))
        assertNull(client.send(valid, proxy = Any()))
        assertTrue(client.send(valid)!!.result().get("done").asBoolean)

        // A renewed confirmation of the same document keeps its session.
        client.confirm(token)
        assertEquals(sid, client.sid)
        assertTrue(client.call(READ, readParams(ref, 0)).result().get("done").asBoolean)
        // A same-origin replacement with the same JavaReplyProxy has a different document token.
        client.confirm("b".repeat(32))
        assertNotEquals(sid, client.sid)
        assertNull(client.send(client.request("old-sid", READ, readParams(ref, 0), sid)))
        assertNull(client.send(client.request("old-doc", READ, readParams(ref, 0)), token = token))
        assertEquals(-32003, client.call(READ, readParams(ref, 0)).errorCode())
        assertEquals(0, fixture.fileCount())
        client.call(CHOOSE).selectedFile()
        assertNull(client.transport.onPageCommitVisible("https://outside.example.test/"))
        assertEquals(0, fixture.fileCount())
    }

    @Test fun cancelAndDocumentReplacementDropLatePickerResults() {
        val fixture = Fixture()
        var late: Continuation<MediaImage?>? = null
        var opened = 0
        fixture.next = { suspendCoroutine { late = it } }
        val client = Client(fixture.module)
        client.confirm()
        assertNull(client.send(client.request("pick", CHOOSE)))
        val first = checkNotNull(late)
        assertEquals(-32008, client.call(CHOOSE).errorCode())
        client.cancel("pick")
        assertEquals(-32002, client.last().errorCode())
        val count = client.replies.size
        first.resume(MediaImage({ "image/png" }) { opened++; byteArrayOf(1).inputStream() })
        assertEquals(count, client.replies.size)
        assertEquals(0, fixture.fileCount())
        assertEquals(0, opened)

        assertNull(client.send(client.request("old", CHOOSE)))
        val second = checkNotNull(late)
        val sid = client.sid
        client.confirm("c".repeat(32))
        assertNotEquals(sid, client.sid)
        val afterReplacement = client.replies.size
        second.resume(MediaImage({ "image/png" }) { opened++; byteArrayOf(1).inputStream() })
        assertEquals(afterReplacement, client.replies.size)
        assertEquals(0, fixture.fileCount())
        assertEquals(0, opened)
        fixture.image(4)
        assertEquals(4, client.call(CHOOSE).selectedFile().get("size").asInt)
    }

    @Test fun abortUnlinksAStagedCopyWhileTheProviderIsStillBlocked() = runBlocking {
        val dir = temporary.newFolder()
        val reading = CountDownLatch(1)
        val unblock = CountDownLatch(1)
        val closed = CountDownLatch(1)
        val module = MediaModule(
            pick = {
                MediaImage({ "image/png" }) {
                    object : InputStream() {
                        override fun read() = error("Use the bounded buffer")
                        override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
                            reading.countDown()
                            check(unblock.await(5, TimeUnit.SECONDS))
                            bytes[offset] = 1
                            return 1
                        }
                        override fun close() { closed.countDown() }
                    }
                }
            },
            directory = dir,
            scheduleExpiry = { _, _ -> error("Cancelled copy must not publish a reference") },
        )
        val session = module.newSession()
        val job = launch(start = CoroutineStart.UNDISPATCHED) { session.choose() }
        try {
            assertTrue("Picker stream never opened", reading.await(5, TimeUnit.SECONDS))
            assertEquals(1, dir.listFiles()!!.size)
            session.abortCopy()
            job.cancel()
            assertEquals("The partial file must be unlinked before the provider unblocks", 0, dir.listFiles()!!.size)
        } finally {
            unblock.countDown()
            job.cancelAndJoin()
            session.close()
        }
        assertEquals(0L, closed.count)
        assertEquals(0, dir.listFiles()!!.size)
    }

    private inner class Fixture {
        val dir: File = temporary.newFolder()
        var epoch = 1_700_000_000_000L
        var elapsed = 0L
        var picks = 0
        var next: suspend () -> MediaImage? = { null }
        private val tasks = mutableMapOf<() -> Unit, Long>()
        val module = MediaModule(
            pick = { picks++; next() }, directory = dir,
            scheduleExpiry = { delay, task -> tasks[task] = elapsed + delay; { tasks.remove(task); Unit } },
            epochMillis = { epoch }, elapsedMillis = { elapsed }, io = Dispatchers.Unconfined,
        )
        fun advance(delta: Long, fireTimers: Boolean = true) {
            elapsed += delta
            epoch += delta
            if (fireTimers) tasks.filterValues { it <= elapsed }.keys.forEach { tasks.remove(it); it() }
        }
        fun image(size: Int, mime: String = "image/png") {
            next = {
                MediaImage({ mime }) {
                    object : InputStream() {
                        var remaining = size
                        override fun read() = if (remaining <= 0) -1 else 0.also { remaining-- }
                        override fun read(b: ByteArray, off: Int, len: Int): Int {
                            if (remaining <= 0) return -1
                            return minOf(remaining, len).also { remaining -= it; b.fill(0, off, off + it) }
                        }
                    }
                }
            }
        }
        fun fileCount() = dir.listFiles()!!.size
    }

    private class Client(module: MediaModule? = null, async: Boolean = true) {
        val replies = mutableListOf<String>()
        val transport = DocumentTransport(ORIGIN, enableEcho = false, modules = BridgeModules(media = module),
            runBusiness = if (async) ({ call, finish ->
                val job = CoroutineScope(Job() + Dispatchers.Unconfined).launch {
                    finish(runCatching {
                        call.handler(call.params).also { currentCoroutineContext().ensureActive() }
                    })
                }
                ({ job.cancel() })
            }) else null,
        )
        var sid = ""
        var token = "a".repeat(32); private set
        private val originalProxy = Any()
        private var id = 0

        fun confirm(docToken: String = token): JsonObject {
            token = docToken
            val challenge = checkNotNull(transport.onPageCommitVisible("$ORIGIN/test"))
            val controls = mutableListOf<String>()
            transport.receive("commit:$challenge:$token", ORIGIN, true, originalProxy, controls::add)
            assertEquals(listOf("ready:$challenge:$token"), controls)
            val hello = checkNotNull(send(request("hello-${id++}", "bridge.hello", """{"protocols":[1]}""", null))).result()
            sid = hello.get("sid").asString
            return hello
        }
        fun call(method: String, params: String? = null) = checkNotNull(send(request("call-${id++}", method, params)))
        fun request(id: String, method: String, params: String? = null, sid: String? = this.sid): String {
            val meta = if (sid == null) "" else ""","meta":{"sid":"$sid"}"""
            val arguments = if (params == null) "" else ""","params":$params"""
            return """{"jsb":"1.0"$meta,"rpc":{"jsonrpc":"2.0","id":${JsonPrimitive(id)},"method":"$method"$arguments}}"""
        }
        fun send(raw: String, token: String = this.token, origin: String = ORIGIN, main: Boolean = true,
                 proxy: Any = originalProxy): JsonObject? {
            val count = replies.size
            transport.receive("rpc:$token:$raw", origin, main, proxy, replies::add)
            return if (count == replies.size) null else last()
        }
        fun cancel(id: String) {
            send("""{"jsb":"1.0","meta":{"sid":"$sid"},"rpc":{"jsonrpc":"2.0","method":"bridge.cancel","params":{"requestId":${JsonPrimitive(id)}}}}""")
        }
        fun last(): JsonObject = obj(replies.last().substringAfter("rpc:$token:")).getAsJsonObject("rpc")
    }

    private companion object {
        const val ORIGIN = "https://media.example.test"
        const val CHOOSE = "media.chooseMedia"
        const val READ = "bridge.blob.read"
        const val RELEASE = "bridge.blob.release"
        const val CHUNK = 64 * 1024
        const val LIMIT = 20 * 1024 * 1024
        const val TTL = 5 * 60 * 1000L
        val UNKNOWN = "0".repeat(32)
        val METHODS = setOf(CHOOSE, READ, RELEASE)
        fun obj(raw: String) = JsonParser.parseString(raw).asJsonObject
        fun readParams(ref: String, index: Int) = """{"blobRef":"$ref","index":$index}"""
        fun refParams(ref: String) = """{"blobRef":"$ref"}"""
        fun JsonObject.result() = getAsJsonObject("result") ?: error("No result: $this")
        fun JsonObject.errorCode() = getAsJsonObject("error")?.get("code")?.asInt ?: error("No error: $this")
        fun JsonObject.limit() = getAsJsonObject("limits").get("maxMessageBytes").asInt
        fun JsonObject.selectedFile(): JsonObject {
            val result = result()
            assertEquals("selected", result.get("status").asString)
            return result.getAsJsonArray("files").single().asJsonObject
        }
        fun JsonObject.ref() = get("blobRef").asString
        fun JsonObject.bytes() = Base64.getDecoder().decode(get("dataBase64").asString)
    }
}
