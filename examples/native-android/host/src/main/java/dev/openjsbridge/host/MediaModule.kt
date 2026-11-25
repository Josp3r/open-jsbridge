package dev.openjsbridge.host

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile
import java.security.SecureRandom
import java.util.Locale
import java.util.concurrent.CancellationException
import kotlin.coroutines.CoroutineContext
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

internal class MediaImage(val mime: () -> String?, val open: () -> InputStream)

internal class MediaFailure(val code: Int, message: String) : RuntimeException(message)

/** One presenter per attachment; each confirmed document gets a separate store. */
internal class MediaModule(
    private val pick: suspend () -> MediaImage?,
    private val directory: File,
    private val scheduleExpiry: (Long, () -> Unit) -> (() -> Unit),
    private val epochMillis: () -> Long = System::currentTimeMillis,
    private val elapsedMillis: () -> Long = { System.nanoTime() / 1_000_000 },
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    fun newSession() = MediaSession(pick, directory, scheduleExpiry, epochMillis, elapsedMillis, io)
}

/** State is owned by the WebView thread. Only bounded file I/O runs on [io]. */
internal class MediaSession(
    private val pick: suspend () -> MediaImage?,
    private val directory: File,
    private val scheduleExpiry: (Long, () -> Unit) -> (() -> Unit),
    private val epochMillis: () -> Long,
    private val elapsedMillis: () -> Long,
    private val io: CoroutineDispatcher,
) {
    private class Blob(val file: File, val size: Int, val expiresAt: Long, val deadline: Long) {
        var cancelExpiry: (() -> Unit)? = null
    }

    // Cancellation/retirement can unlink the copy before a blocked content provider
    // returns. Open the output once, under the same lock, so I/O cannot recreate it.
    private class StagedCopy(private val directory: File) {
        private var file: File? = null
        private var output: OutputStream? = null
        private var discarded = false

        @Synchronized fun open(): OutputStream {
            if (discarded) throw CancellationException()
            if (!directory.isDirectory && !directory.mkdirs() && !directory.isDirectory) {
                throw IOException("Media cache unavailable")
            }
            val temp = File.createTempFile("ojsb-media-", ".tmp", directory)
            file = temp
            return temp.outputStream().also { output = it }
        }

        @Synchronized fun take(): File = checkNotNull(file).also { file = null }

        @Synchronized fun discard() {
            discarded = true
            // Release the local descriptor even if the remote provider is still blocked.
            runCatching { output?.close() }
            output = null
            file?.delete()
            file = null
        }
    }

    private val entries = mutableMapOf<String, Blob>()
    private var allocated = 0
    private var closed = false
    private var pending: StagedCopy? = null

    suspend fun choose(): JsonObject {
        check(!closed)
        val image = pick()
        currentCoroutineContext().ensureActive()
        check(!closed)
        if (image == null) return choice("cancelled")
        sweepExpired()
        val budget = MAX_BYTES - allocated
        if (budget == 0) throw tooLarge()
        val staged = StagedCopy(directory)
        check(pending == null)
        pending = staged
        try {
            val (mime, size) = withContext(io) {
                val mime = image.mime()?.lowercase(Locale.ROOT)?.takeIf(IMAGE_MIME::matches)
                    ?: throw IOException("Selected item is not an image")
                val context = currentCoroutineContext()
                val size = staged.open().use { output ->
                    image.open().use { input -> copyBounded(context, input, output, budget) }
                }
                if (size == 0) throw IOException("Selected image is empty")
                mime to size
            }
            currentCoroutineContext().ensureActive()
            check(!closed && pending === staged)
            val ref = generateSequence(::randomRef).first { it !in entries }
            val blob = Blob(staged.take(), size, epochMillis() + TTL_MILLIS, elapsedMillis() + TTL_MILLIS)
            entries[ref] = blob
            allocated += size
            try {
                blob.cancelExpiry = scheduleExpiry(TTL_MILLIS) { remove(ref) }
            } catch (error: RuntimeException) {
                remove(ref)
                throw error
            }
            return choice("selected", JsonObject().apply {
                addProperty("type", "image")
                addProperty("blobRef", ref)
                addProperty("mime", mime)
                addProperty("size", size)
                addProperty("expiresAt", blob.expiresAt)
            })
        } finally {
            if (pending === staged) pending = null
            staged.discard()
        }
    }

    @OptIn(ExperimentalEncodingApi::class)
    suspend fun read(ref: String, index: Long): JsonObject {
        sweepExpired()
        val blob = entries[ref] ?: throw permissionDenied()
        if (index !in 0..((blob.size - 1) / CHUNK_BYTES).toLong()) throw MediaFailure(-32602, "Invalid params")
        val offset = index * CHUNK_BYTES
        val count = minOf(CHUNK_BYTES.toLong(), blob.size - offset).toInt()
        val encoded = try {
            withContext(io) {
                val bytes = ByteArray(count)
                RandomAccessFile(blob.file, "r").use { file -> file.seek(offset); file.readFully(bytes) }
                Base64.encode(bytes)
            }
        } catch (error: IOException) {
            sweepExpired()
            if (entries[ref] !== blob) throw permissionDenied()
            throw error
        }
        sweepExpired()
        if (entries[ref] !== blob) throw permissionDenied()
        return JsonObject().apply {
            addProperty("dataBase64", encoded)
            addProperty("done", offset + count == blob.size.toLong())
        }
    }

    fun release(ref: String): JsonObject {
        remove(ref)
        return JsonObject()
    }

    fun abortCopy() {
        pending?.discard()
        pending = null
    }

    fun close() {
        closed = true
        abortCopy()
        entries.keys.toList().forEach(::remove)
    }

    private fun sweepExpired() {
        val elapsed = elapsedMillis()
        val now = epochMillis()
        entries.filterValues { it.deadline <= elapsed || it.expiresAt <= now }.keys.forEach(::remove)
    }

    private fun remove(ref: String) {
        val previous = entries.remove(ref) ?: return
        allocated -= previous.size
        previous.cancelExpiry?.invoke()
        previous.file.delete()
    }

    companion object {
        private const val MAX_BYTES = 20 * 1024 * 1024
        private const val CHUNK_BYTES = 64 * 1024
        const val MAX_CHUNK_INDEX = MAX_BYTES / CHUNK_BYTES - 1
        private const val TTL_MILLIS = 5 * 60 * 1000L
        private val IMAGE_MIME = Regex("image/[a-z0-9!#$&^_.+\\-]{1,122}")
        private val random = SecureRandom()
        private const val HEX = "0123456789abcdef"

        private fun randomRef(): String = buildString(32) {
            for (byte in ByteArray(16).also(random::nextBytes)) {
                append(HEX[(byte.toInt() ushr 4) and 15]); append(HEX[byte.toInt() and 15])
            }
        }

        private fun copyBounded(context: CoroutineContext, input: InputStream, output: OutputStream, budget: Int): Int {
            val buffer = ByteArray(8192)
            var total = 0
            while (true) {
                context.ensureActive()
                val count = input.read(buffer, 0, minOf(buffer.size, budget - total + 1))
                context.ensureActive()
                if (count < 0) return total
                if (count == 0) {
                    val single = input.read()
                    context.ensureActive()
                    if (single < 0) return total
                    if (total == budget) throw tooLarge()
                    output.write(single)
                    total++
                } else {
                    if (count > budget - total) throw tooLarge()
                    output.write(buffer, 0, count)
                    total += count
                }
            }
        }

        private fun choice(status: String, file: JsonObject? = null) = JsonObject().apply {
            addProperty("status", status)
            add("files", JsonArray().apply { file?.let(::add) })
        }

        private fun tooLarge() = MediaFailure(-32006, "Payload too large")
        private fun permissionDenied() = MediaFailure(-32003, "Permission denied")
    }
}
