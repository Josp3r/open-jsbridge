package dev.openjsbridge.host

import com.google.gson.JsonObject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.GZIPOutputStream

class TransferUploadHttpTest {
    @get:Rule val files = TemporaryFolder()
    private val server = MockWebServer()
    private val cancelledOnWire = CountDownLatch(1)
    private val postAttempts = AtomicInteger()
    private lateinit var serverTls: HandshakeCertificates
    private lateinit var http: TransferUploadHttp
    private lateinit var upload: AuthorizedUpload
    private lateinit var photo: File

    @Before fun setUp() {
        val certificate = HeldCertificate.Builder()
            .addSubjectAlternativeName("127.0.0.1")
            .addSubjectAlternativeName("localhost")
            .build()
        serverTls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val clientTls = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        server.useHttps(serverTls.sslSocketFactory(), false)
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        http = TransferUploadHttp(customizeTls = {
            sslSocketFactory(clientTls.sslSocketFactory(), clientTls.trustManager)
            eventListener(object : EventListener() {
                override fun canceled(call: Call) { cancelledOnWire.countDown() }
                override fun requestHeadersEnd(call: Call, request: Request) {
                    if (request.method == "POST") postAttempts.incrementAndGet()
                }
            })
        })
        val url = server.url("/upload").toString()
        val origin = "https://app.example"
        val endpoint = TransferUploadEndpoint(origin, url, formFields = mapOf("tag" to { _: String -> true }),
            credentials = { mapOf("Authorization" to "Bearer fixture") })
        val params = JsonObject().apply {
            addProperty("id", "0123456789abcdef0123456789abcdef")
            add("request", JsonObject().apply {
                addProperty("url", url)
                add("formData", JsonObject().apply { addProperty("tag", "蓝色") })
            })
        }
        upload = TransferUploadPolicy(listOf(endpoint)).authorize(origin, params)
        photo = files.newFile("private-name.jpeg").apply {
            writeBytes(byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0, 25, 0xff.toByte(), 0xd9.toByte()))
        }
    }

    @After fun close() { server.shutdown() }

    private suspend fun send(
        sender: TransferUploadHttp = http,
        progress: (Long, Long) -> Unit = { _, _ -> },
    ): JsonObject = sender.send(upload, upload.requestHeaders(), photo, {}, progress)

    private fun request(): RecordedRequest = checkNotNull(server.takeRequest(3, TimeUnit.SECONDS))

    @Test(timeout = 15_000) fun sendsOneFileAndTextPartAndCountsTheWholeBody() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(201).setHeader("Content-Type", "application/json; charset=utf-8")
            .setHeader("Set-Cookie", "shared=secret").setBody("""{"photo":"雪"}"""))
        val progress = mutableListOf<Pair<Long, Long>>()
        val result = send { sent, total -> progress.add(sent to total) }
        assertEquals(setOf("status", "body"), result.keySet())
        assertEquals(201, result.get("status").asInt)
        assertEquals("""{"photo":"雪"}""", result.get("body").asString)

        val req = request()
        assertEquals("POST", req.method)
        assertEquals("/upload", req.path)
        assertEquals("Bearer fixture", req.getHeader("Authorization"))
        val contentType = checkNotNull(req.getHeader("Content-Type"))
        assertTrue(contentType.startsWith("multipart/form-data;"))
        val boundary = contentType.substringAfter("boundary=").trim('"')
        val parts = req.body.readString(Charsets.ISO_8859_1).split("--$boundary").drop(1).dropLast(1)
        assertEquals(2, parts.size)
        val image = parts.single { "name=\"file\"; filename=\"image.jpg\"" in it }
        assertTrue(image.substringBefore("\r\n\r\n").contains("Content-Type: image/jpeg", ignoreCase = true))
        assertArrayEquals(photo.readBytes(), image.substringAfter("\r\n\r\n").removeSuffix("\r\n")
            .toByteArray(Charsets.ISO_8859_1))
        val text = parts.single { "name=\"tag\"" in it }
        assertArrayEquals("蓝色".toByteArray(), text.substringAfter("\r\n\r\n").removeSuffix("\r\n")
            .toByteArray(Charsets.ISO_8859_1))
        val total = req.bodySize
        assertTrue(total > photo.length())
        assertEquals(total, req.getHeader("Content-Length")?.toLong())
        assertTrue(progress.isNotEmpty())
        assertTrue(progress.all { (sent, fixedTotal) -> fixedTotal == total && sent in 0L..total })
        assertTrue(progress.zipWithNext().all { (a, b) -> a.first <= b.first })
        assertEquals(total, progress.last().first)

        server.enqueue(MockResponse().setResponseCode(204))
        val empty = send()
        assertEquals(204, empty.get("status").asInt)
        assertEquals("", empty.get("body").asString)
        assertNull(request().getHeader("Cookie"))
    }

    @Test(timeout = 15_000) fun returnsHttpErrorsAndDoesNotRetryServiceUnavailable() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(413).setHeader("Content-Type", "text/plain").setBody("too big"))
        val rejected = send()
        assertEquals(413, rejected.get("status").asInt)
        assertEquals("too big", rejected.get("body").asString)
        server.enqueue(MockResponse().setResponseCode(503).setHeader("Retry-After", "0")
            .setHeader("Content-Type", "text/plain").setBody("busy"))
        server.enqueue(MockResponse().setResponseCode(204)) // Would reveal a replay.
        val unavailable = send()
        assertEquals(503, unavailable.get("status").asInt)
        assertEquals("busy", unavailable.get("body").asString)
        assertEquals(2, server.requestCount)
    }

    @Test(timeout = 15_000) fun redirectsNeverReachAnotherEndpoint() = runBlocking {
        val other = MockWebServer()
        try {
            other.useHttps(serverTls.sslSocketFactory(), false)
            other.start(InetAddress.getByName("127.0.0.1"), 0)
            other.enqueue(MockResponse().setResponseCode(204))
            server.enqueue(MockResponse().setResponseCode(307)
                .setHeader("Location", other.url("/different")))
            checkFailure(-32003, "redirect_denied") { send() }
            assertEquals(1, server.requestCount)
            assertEquals(0, other.requestCount)
            server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", server.url("/different")))
            server.enqueue(MockResponse().setResponseCode(204))
            checkFailure(-32003, "redirect_denied") { send() }
            assertEquals(2, server.requestCount)
        } finally {
            other.shutdown()
        }
    }

    private fun gzip(text: String): ByteArray {
        val compressed = ByteArrayOutputStream()
        GZIPOutputStream(compressed).use { it.write(text.toByteArray()) }
        return compressed.toByteArray()
    }

    private fun gzipResponse(member: ByteArray) = MockResponse()
        .setHeader("Content-Type", "text/plain").setHeader("Content-Encoding", "gzip")
        .setBody(Buffer().write(member))

    @Test(timeout = 15_000) fun enforcesTheDecompressedResponseLimit() = runBlocking {
        server.enqueue(gzipResponse(gzip("x".repeat(32 * 1024))))
        assertEquals("x".repeat(32 * 1024), send().get("body").asString)
        server.enqueue(gzipResponse(gzip("x".repeat(32 * 1024 + 1))))
        checkFailure(-32006) { send() }
    }

    @Test(timeout = 15_000) fun acceptsOneCompleteGzipMemberAndRejectsMalformedOrExtraData() = runBlocking {
        server.enqueue(gzipResponse(gzip("")))
        assertEquals("", send().get("body").asString)
        server.enqueue(gzipResponse(byteArrayOf(0x1f, 0x8b.toByte())))
        checkFailure(-32603, "invalid_response") { send() }
        val valid = gzip("first")
        server.enqueue(gzipResponse(valid + byteArrayOf(1, 2)))
        checkFailure(-32603, "invalid_response") { send() }
        server.enqueue(gzipResponse(valid + gzip("second")))
        checkFailure(-32603, "invalid_response") { send() }
    }

    @Test(timeout = 15_000) fun lostHttpBytesAfterACompleteGzipMemberAreANetworkFailure() = runBlocking {
        server.protocols = listOf(Protocol.HTTP_1_1)
        val valid = gzip("complete member")
        server.enqueue(gzipResponse(valid).setHeader("Content-Length", valid.size + 1)
            .setSocketPolicy(SocketPolicy.DISCONNECT_AT_END))
        checkFailure(-32603, "network_failure") { send() }
    }

    @Test(timeout = 15_000) fun rejectsBadUtf8AndUnapprovedResponseTypes() = runBlocking {
        server.enqueue(MockResponse().setHeader("Content-Type", "text/plain")
            .setBody(Buffer().write(byteArrayOf(0xc3.toByte(), 0x28))))
        checkFailure(-32603, "invalid_response") { send() }
        server.enqueue(MockResponse().setHeader("Content-Type", "image/png").setBody("not public"))
        checkFailure(-32603, "invalid_response") { send() }
        server.enqueue(MockResponse().setHeader("Content-Type", "text/plain; charset=iso-8859-1").setBody("public"))
        checkFailure(-32603, "invalid_response") { send() }
        server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("{"))
        checkFailure(-32603, "invalid_response") { send() }
    }

    @Test(timeout = 15_000) fun revokedHandleStopsBeforeStartingOrDuringTheFirstPost() = runBlocking {
        val expired = MediaFailure(-32003, "handle_expired")
        val headers = upload.requestHeaders()
        try {
            http.send(upload, headers, photo, { throw expired }, { _, _ -> })
            throw AssertionError("Expected the preflight check to reject the transfer")
        } catch (failure: MediaFailure) {
            assertSame(expired, failure)
        }
        assertEquals(0, postAttempts.get())
        assertEquals(0, server.requestCount)

        photo.outputStream().use { out ->
            val chunk = ByteArray(64 * 1024)
            repeat(64) { out.write(chunk) }
        }
        server.enqueue(MockResponse().setResponseCode(204))
        val revoked = AtomicBoolean()
        try {
            http.send(upload, headers, photo, { if (revoked.get()) throw expired }) { sent, total ->
                if (sent in 1 until total) revoked.set(true)
            }
            throw AssertionError("Expected the transfer to stop after the handle expired")
        } catch (failure: MediaFailure) {
            assertSame(expired, failure)
        }
        assertTrue(revoked.get())
        assertEquals(1, postAttempts.get())
    }

    @Test(timeout = 15_000) fun lostResponseNeverReplaysThePost() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        server.enqueue(MockResponse().setResponseCode(204))
        checkFailure(-32603, "network_failure") { send() }
        assertEquals("POST", request().method)
        assertEquals(1, server.requestCount)
    }

    @Test(timeout = 15_000) fun cancellationAbortsTheCallWhileWaitingForHeaders() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val job = launch(Dispatchers.IO) { send() }
        assertEquals("POST", request().method)
        withTimeout(3_000) { job.cancelAndJoin() }
        assertTrue(cancelledOnWire.await(3, TimeUnit.SECONDS))
        assertEquals(1, server.requestCount)
    }

    @Test(timeout = 15_000) fun defaultClientRejectsAnUntrustedServer() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))
        checkFailure(-32603, "network_failure") { send(TransferUploadHttp()) }
    }

    private suspend fun checkFailure(code: Int, reason: String? = null, block: suspend () -> JsonObject) {
        try {
            block()
            throw AssertionError("Expected transfer failure $code")
        } catch (failure: MediaFailure) {
            assertEquals(code, failure.code)
            if (reason != null) assertEquals(reason, failure.message)
        }
    }
}
