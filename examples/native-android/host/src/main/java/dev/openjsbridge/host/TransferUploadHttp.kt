package dev.openjsbridge.host

import com.google.gson.JsonObject
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.Headers
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.Response
import okio.Buffer
import okio.BufferedSink
import okio.ForwardingSink
import okio.ForwardingSource
import okio.GzipSource
import okio.Source
import okio.buffer
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A client private to this host, with no automatic POST replay or shared HTTP state. */
internal class TransferUploadHttp(customizeTls: OkHttpClient.Builder.() -> Unit = {}) {
    private val client = OkHttpClient.Builder()
        .apply(customizeTls)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .cookieJar(CookieJar.NO_COOKIES).authenticator(Authenticator.NONE).proxyAuthenticator(Authenticator.NONE)
        .cache(null)
        // The RPC deadline covers preparation, connection, writing and reading.
        .connectTimeout(0, TimeUnit.MILLISECONDS).writeTimeout(0, TimeUnit.MILLISECONDS).readTimeout(0, TimeUnit.MILLISECONDS)
        .addInterceptor { chain ->
            val request = chain.request()
            request.tag(UploadGuard::class.java)!!.check()
            chain.proceed(request)
        }
        .addNetworkInterceptor { chain ->
            // Recheck permission after DNS/TLS and immediately before sending the headers.
            val request = chain.request()
            request.tag(UploadGuard::class.java)!!.check()
            chain.proceed(request)
        }
        .build()

    suspend fun send(
        upload: AuthorizedUpload,
        headers: Map<String, String>,
        jpeg: File,
        checkActive: () -> Unit,
        progress: (Long, Long) -> Unit,
    ): JsonObject {
        checkActive()
        val guard = UploadGuard(checkActive)
        val multipart = MultipartBody.Builder().setType(MultipartBody.FORM).apply {
            for ((name, value) in upload.formData) addFormDataPart(name, value)
            addFormDataPart(upload.fieldName, "image.jpg", jpeg.asRequestBody("image/jpeg".toMediaType()))
        }.build()
        val requestHeaders = Headers.Builder().apply {
            // Policy already validated field names and control characters. Values may be UTF-8.
            for ((name, value) in headers) addUnsafeNonAscii(name, value)
            // Handle gzip explicitly so the byte limit applies to decoded content in every case.
            if (get("Accept-Encoding") == null) add("Accept-Encoding", "gzip")
        }.build()
        val request = Request.Builder().url(upload.target).headers(requestHeaders)
            .tag(UploadGuard::class.java, guard)
            .post(UploadBody(multipart, guard, progress)).build()
        return suspendCancellableCoroutine { continuation ->
            val call = client.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            if (!continuation.isActive) return@suspendCancellableCoroutine
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    continuation.resumeWithException(guard.failure ?: networkFailure())
                }

                override fun onResponse(call: Call, response: Response) {
                    try {
                        val result = response.use {
                            checkActive()
                            if (it.code in 300..399) throw MediaFailure(-32003, "redirect_denied")
                            if (it.code !in 200..599) throw invalidResponse()
                            JsonObject().apply {
                                addProperty("status", it.code)
                                addProperty("body", readText(it, upload.responseTypes, checkActive))
                            }
                        }
                        checkActive()
                        continuation.resume(result)
                    } catch (error: RuntimeException) {
                        continuation.resumeWithException(error)
                    } catch (_: IOException) {
                        continuation.resumeWithException(guard.failure ?: networkFailure())
                    }
                }
            })
        }
    }

    private fun readText(response: Response, responseTypes: Set<String>, checkActive: () -> Unit): String {
        val body = response.body ?: return ""
        val raw = body.source()
        if (raw.exhausted()) return ""
        val encoding = response.headers.values("Content-Encoding").joinToString(",").trim()
        val bytes = when {
            encoding.isEmpty() || encoding.equals("identity", true) -> readBounded(raw, checkActive)
            encoding.equals("gzip", true) -> readGzip(raw, checkActive)
            else -> throw invalidResponse()
        }
        if (bytes.isEmpty()) return ""
        val type = body.contentType() ?: throw invalidResponse()
        val charset = type.parameter("charset")
        if (response.headers.values("Content-Type").size != 1 || "${type.type}/${type.subtype}" !in responseTypes ||
            (charset != null && !charset.equals("UTF-8", true))) throw invalidResponse()
        val text = try {
            Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString()
        } catch (_: CharacterCodingException) {
            throw invalidResponse()
        }
        if (type.type == "application" && (type.subtype == "json" || type.subtype.endsWith("+json"))) {
            try {
                JsonReader(text.reader()).use {
                    it.strictness = Strictness.STRICT
                    if (it.peek() == JsonToken.END_DOCUMENT) throw invalidResponse()
                    it.skipValue()
                    if (it.peek() != JsonToken.END_DOCUMENT) throw invalidResponse()
                }
            } catch (_: IOException) {
                throw invalidResponse()
            }
        }
        return text
    }

    private fun readGzip(raw: Source, checkActive: () -> Unit): ByteArray {
        // Preserve HTTP framing and socket errors separately from a malformed gzip representation.
        val wire = object : ForwardingSource(raw) {
            override fun read(sink: Buffer, byteCount: Long) = try {
                super.read(sink, byteCount)
            } catch (_: IOException) {
                throw networkFailure()
            }
        }
        return try {
            // GzipSource validates one member's CRC, trailer and the end of the underlying body.
            GzipSource(wire).use { readBounded(it, checkActive) }
        } catch (_: IOException) {
            throw invalidResponse()
        }
    }

    private fun readBounded(source: Source, checkActive: () -> Unit): ByteArray {
        val limit = 32L * 1024
        val buffer = Buffer()
        while (buffer.size <= limit) {
            checkActive()
            if (source.read(buffer, minOf(8192L, limit + 1 - buffer.size)) == -1L) return buffer.readByteArray()
        }
        throw MediaFailure(-32006, "Payload too large")
    }
}

private fun invalidResponse() = MediaFailure(-32603, "invalid_response")
private fun networkFailure() = MediaFailure(-32603, "network_failure")

/** OkHttp worker callbacks must report exceptions as IOExceptions; keep the original RPC failure. */
private class UploadGuard(private val checkActive: () -> Unit) {
    @Volatile var failure: RuntimeException? = null
        private set

    fun check() = onWorker(checkActive)

    inline fun onWorker(action: () -> Unit) {
        try {
            action()
        } catch (error: RuntimeException) {
            failure = error
            throw IOException("Upload stopped")
        }
    }
}

private class UploadBody(
    private val multipart: MultipartBody,
    private val guard: UploadGuard,
    private val progress: (Long, Long) -> Unit,
) : RequestBody() {
    override fun contentType() = multipart.contentType()
    override fun contentLength() = multipart.contentLength()
    // Also prevents status-driven follow-up POSTs (for example 503 with Retry-After: 0).
    override fun isOneShot() = true

    override fun writeTo(sink: BufferedSink) {
        val total = contentLength()
        var sent = 0L
        val counted = object : ForwardingSink(sink) {
            override fun write(source: Buffer, byteCount: Long) {
                guard.check()
                super.write(source, byteCount)
                sent += byteCount
                if (total > 0) guard.onWorker { progress(sent, total) }
            }
        }.buffer()
        multipart.writeTo(counted)
        counted.emit()
    }
}
