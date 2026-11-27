package dev.openjsbridge.host

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.exifinterface.media.ExifInterface
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartReader
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.net.InetAddress
import java.net.Proxy
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class TransferUploadDeviceTest {
    @get:Rule val temporary = TemporaryFolder(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir)
    private val server = MockWebServer()

    @After fun closeServer() = server.shutdown()

    @Test fun uploadFromChosenImageDeliversOrientedJpegAndRetainsOnlyThePrivateOriginal() = runBlocking {
        val source = temporary.newFile("private-camera.jpg")
        val bitmap = Bitmap.createBitmap(96, 48, Bitmap.Config.ARGB_8888)
        try {
            bitmap.eraseColor(Color.BLUE)
            Canvas(bitmap).drawRect(0f, 0f, 48f, 48f, Paint().apply { color = Color.RED })
            source.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it)) }
        } finally {
            bitmap.recycle()
        }
        ExifInterface(source).apply {
            setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_ROTATE_90.toString())
            setLatLong(12.5, -97.25)
            saveAttributes()
        }

        val origin = "https://app.example"
        val address = "127.0.0.1"
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName(address).build()
        val serverTls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val clientTls = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        server.useHttps(serverTls.sslSocketFactory(), false)
        server.start(InetAddress.getByName(address), 0)
        server.enqueue(MockResponse().setResponseCode(201).setHeader("Content-Type", "application/json")
            .setBody("""{"asset":"avatar"}"""))
        val endpoint = server.url("/avatar").newBuilder().host(address).build().toString()
        val http = TransferUploadHttp {
            proxy(Proxy.NO_PROXY)
            sslSocketFactory(clientTls.sslSocketFactory(), clientTls.trustManager)
        }
        val store = temporary.newFolder()
        val media = MediaModule({ MediaImage({ "image/jpeg" }, source::inputStream) }, store,
            ::androidMediaThumbnail, scheduleExpiry = { _, _ -> {} })
        val upload = TransferUploadModule(
            policy = TransferUploadPolicy(listOf(TransferUploadEndpoint(origin, endpoint,
                formFields = mapOf("purpose" to { it == "头像" }), credentials = { mapOf("Authorization" to "Bearer device-test") }))),
            isForeground = { true }, observeBackground = { {} }, schedule = { _, _ -> {} },
            send = http::send,
        )
        val transport = DocumentTransport(listOf(origin), false, BridgeModules(media = media, upload = upload),
            runBusiness = { call, finish ->
                val job = launch { finish(runCatching { call.handler() }) }
                ({ job.cancel() })
            })
        val proxy = Any()
        val token = "a".repeat(32)
        val nonce = checkNotNull(transport.onPageCommitVisible(origin)).nonce
        transport.receive("commit:$nonce:$token", origin, true, proxy) { assertEquals("ready:$nonce:$token", it) }
        var sid: String? = null
        suspend fun rpc(id: String, method: String, params: String): JsonElement {
            val result = CompletableDeferred<JsonObject>()
            val meta = sid?.let { ""","meta":{"sid":"$it"}""" }.orEmpty()
            val raw = """{"jsb":"1.0"$meta,"rpc":{"jsonrpc":"2.0","id":"$id","method":"$method","params":$params}}"""
            transport.receive("rpc:$token:$raw", origin, true, proxy) {
                val response = JsonParser.parseString(it.removePrefix("rpc:$token:")).asJsonObject.getAsJsonObject("rpc")
                if (response.get("id")?.asString == id) result.complete(response)
            }
            val response = withTimeout(20_000) { result.await() }
            assertTrue(response.toString(), response.has("result"))
            return response.get("result")
        }
        try {
            val hello = rpc("hello", "bridge.hello", """{"protocols":[1]}""").asJsonObject
            sid = hello.get("sid").asString
            assertTrue(hello.getAsJsonObject("capabilities").getAsJsonObject("methods").has("transfer.upload"))
            val choice = rpc("choose", "media.chooseMedia@1", "{}").asJsonObject
            val id = choice.getAsJsonArray("files").single().asJsonObject.get("id").asString
            val result = rpc("upload", "transfer.upload@1",
                """{"id":"$id","request":{"url":"$endpoint","formData":{"purpose":"头像"},"compress":{"maxEdge":24}}}""").asJsonObject
            assertEquals(201, result.get("status").asInt)
            assertEquals("""{"asset":"avatar"}""", result.get("body").asString)
            val request = checkNotNull(server.takeRequest(3, TimeUnit.SECONDS))
            assertEquals(1, server.requestCount)
            assertEquals("POST", request.method)
            assertEquals("/avatar", request.path)
            assertEquals("Bearer device-test", request.getHeader("Authorization"))
            val posted = uploadedJpeg(request)
            val pixels = checkNotNull(BitmapFactory.decodeByteArray(posted, 0, posted.size))
            try {
                assertEquals(12, pixels.width)
                assertEquals(24, pixels.height)
                assertTrue(Color.red(pixels.getPixel(6, 4)) > 200)
                assertTrue(Color.blue(pixels.getPixel(6, 19)) > 200)
            } finally {
                pixels.recycle()
            }
            assertEquals(0xff, posted[0].toInt() and 0xff)
            assertEquals(0xd8, posted[1].toInt() and 0xff)
            assertNull(ExifInterface(posted.inputStream()).latLong)
            assertArrayEquals(source.readBytes(), store.listFiles()!!.single().readBytes())
            assertTrue(rpc("release", "media.release@1", """{"ids":["$id"]}""").isJsonNull)
            assertTrue(store.listFiles()!!.isEmpty())
        } finally {
            transport.invalidate()
        }
    }

    private fun uploadedJpeg(request: RecordedRequest): ByteArray {
        val type = checkNotNull(request.getHeader("Content-Type")).toMediaType()
        assertEquals("multipart/form-data", "${type.type}/${type.subtype}")
        val file = "form-data; name=\"file\"; filename=\"image.jpg\""
        val text = "form-data; name=\"purpose\""
        val parts = mutableMapOf<String, ByteArray>()
        MultipartReader(request.body, checkNotNull(type.parameter("boundary"))).use { reader ->
            while (true) {
                val part = reader.nextPart() ?: break
                part.use {
                    val name = checkNotNull(it.headers["Content-Disposition"])
                    if (name == file) assertEquals("image/jpeg", it.headers["Content-Type"])
                    assertNull("Duplicate multipart field $name", parts.put(name, it.body.readByteArray()))
                }
            }
        }
        assertEquals(setOf(file, text), parts.keys)
        assertArrayEquals("头像".toByteArray(), parts.getValue(text))
        return parts.getValue(file)
    }
}
