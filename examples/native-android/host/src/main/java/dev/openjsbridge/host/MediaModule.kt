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
import java.security.SecureRandom
import java.util.Locale
import java.util.concurrent.CancellationException
import kotlin.coroutines.CoroutineContext
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

internal class MediaImage(val mime: () -> String?, val open: () -> InputStream)

/** Original oriented dimensions and a separately encoded JPEG sample. */
internal data class MediaThumbnail(val width: Int, val height: Int, val jpeg: ByteArray) {
    companion object {
        const val MAX_EDGE = 256
        const val MAX_BYTES = 32 * 1024
    }
}

internal class MediaFailure(val code: Int, message: String) : RuntimeException(message)

/** One presenter per attachment; each confirmed document gets a separate store. */
internal class MediaModule(
    private val pick: suspend () -> MediaImage?,
    private val directory: File,
    private val generateThumbnail: (File) -> MediaThumbnail,
    private val scheduleExpiry: (Long, () -> Unit) -> (() -> Unit),
    private val epochMillis: () -> Long = System::currentTimeMillis,
    private val elapsedMillis: () -> Long = { System.nanoTime() / 1_000_000 },
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    fun newSession() = MediaSession(
        pick, directory, generateThumbnail, scheduleExpiry, epochMillis, elapsedMillis, io,
    )
}

/** State is owned by the WebView thread. Copying and thumbnail preparation run on [io]. */
internal class MediaSession(
    private val pick: suspend () -> MediaImage?,
    private val directory: File,
    private val generateThumbnail: (File) -> MediaThumbnail,
    private val scheduleExpiry: (Long, () -> Unit) -> (() -> Unit),
    private val epochMillis: () -> Long,
    private val elapsedMillis: () -> Long,
    private val io: CoroutineDispatcher,
) {
    private data class PreparedSelection(
        val mime: String,
        val size: Int,
        val width: Int,
        val height: Int,
        val thumbnailBase64: String,
    )

    private class Selection(val file: File, val size: Int, val expiresAt: Long, val deadline: Long) {
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

        @Synchronized fun stagedFile(): File = file ?: throw CancellationException()

        @Synchronized fun take(): File = stagedFile().also { file = null }

        @Synchronized fun discard() {
            discarded = true
            // Release the local descriptor even if the remote provider is still blocked.
            runCatching { output?.close() }
            output = null
            file?.delete()
            file = null
        }
    }

    private val entries = mutableMapOf<String, Selection>()
    private var allocated = 0
    private var closed = false
    private var pending: StagedCopy? = null

    @OptIn(ExperimentalEncodingApi::class)
    suspend fun choose(): JsonObject {
        check(!closed)
        val image = pick()
        currentCoroutineContext().ensureActive()
        check(!closed)
        if (image == null) return choice("cancelled")
        sweepExpired()
        val budget = MAX_STORED_BYTES - allocated
        if (budget == 0) throw tooLarge()
        val staged = StagedCopy(directory)
        check(pending == null)
        pending = staged
        try {
            val selected = withContext(io) {
                val mime = image.mime()?.lowercase(Locale.ROOT)?.takeIf(IMAGE_MIME::matches)
                    ?: throw IOException("Selected item is not an image")
                val context = currentCoroutineContext()
                val size = staged.open().use { output ->
                    image.open().use { input -> copyBounded(context, input, output, budget) }
                }
                if (size == 0) throw IOException("Selected image is empty")
                context.ensureActive()
                val thumbnail = generateThumbnail(staged.stagedFile())
                context.ensureActive()
                if (thumbnail.width <= 0 || thumbnail.height <= 0 || thumbnail.jpeg.isEmpty()) {
                    throw IOException("Invalid media thumbnail")
                }
                if (thumbnail.jpeg.size > MediaThumbnail.MAX_BYTES) throw tooLarge()
                PreparedSelection(mime, size, thumbnail.width, thumbnail.height, Base64.encode(thumbnail.jpeg))
            }
            currentCoroutineContext().ensureActive()
            check(!closed && pending === staged)
            val id = generateSequence(::randomId).first { it !in entries }
            val selection = Selection(staged.take(), selected.size, epochMillis() + TTL_MILLIS, elapsedMillis() + TTL_MILLIS)
            entries[id] = selection
            allocated += selected.size
            try {
                selection.cancelExpiry = scheduleExpiry(TTL_MILLIS) { remove(id) }
            } catch (error: RuntimeException) {
                remove(id)
                throw error
            }
            return choice("selected", JsonObject().apply {
                addProperty("type", "image")
                addProperty("id", id)
                addProperty("mime", selected.mime)
                addProperty("size", selected.size)
                addProperty("width", selected.width)
                addProperty("height", selected.height)
                addProperty("expiresAt", selection.expiresAt)
                addProperty("thumbnailBase64", selected.thumbnailBase64)
            })
        } finally {
            if (pending === staged) pending = null
            staged.discard()
        }
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

    private fun remove(id: String) {
        val previous = entries.remove(id) ?: return
        allocated -= previous.size
        previous.cancelExpiry?.invoke()
        previous.file.delete()
    }

    companion object {
        private const val MAX_STORED_BYTES = 20 * 1024 * 1024
        private const val TTL_MILLIS = 5 * 60 * 1000L
        private val IMAGE_MIME = Regex("image/[a-z0-9!#$&^_.+\\-]{1,122}")
        private val random = SecureRandom()
        private const val HEX = "0123456789abcdef"

        private fun randomId(): String = buildString(32) {
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
    }
}
