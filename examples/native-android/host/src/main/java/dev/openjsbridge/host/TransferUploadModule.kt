package dev.openjsbridge.host

import com.google.gson.JsonObject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

internal class TransferUploadModule(
    private val policy: TransferUploadPolicy,
    internal val isForeground: () -> Boolean,
    internal val observeBackground: (() -> Unit) -> (() -> Unit),
    internal val schedule: (Long, () -> Unit) -> (() -> Unit),
    val elapsedMillis: () -> Long = { System.nanoTime() / 1_000_000 },
    internal val io: CoroutineDispatcher = Dispatchers.IO,
    internal val prepare: (File, File, Int, Int, () -> Unit) -> File = AndroidUploadImage::prepare,
    internal val send: suspend (AuthorizedUpload, Map<String, String>, File, () -> Unit, (Long, Long) -> Unit) -> JsonObject =
        TransferUploadHttp()::send,
) {
    fun allows(origin: String) = policy.allows(origin)

    /** Called on the document thread in the same dispatch that reserves its upload slot. */
    fun open(
        origin: String, media: MediaSession, params: JsonObject?, timeoutMs: Long, receivedAtMillis: Long? = null,
    ): TransferUploadTask {
        val start = receivedAtMillis ?: elapsedMillis()
        if (!isForeground()) throw MediaFailure(-32003, "Permission denied")
        val request = policy.authorize(origin, params)
        return TransferUploadTask(this, request, media, start + timeoutMs)
    }
}

/** Registration and terminal transitions run on the WebView thread. Workers may only check the grant. */
internal class TransferUploadTask(
    private val module: TransferUploadModule,
    private val request: AuthorizedUpload,
    media: MediaSession,
    private val deadline: Long,
) {
    private var onStop: ((MediaFailure) -> Unit)? = null
    private var cancelTimer: (() -> Unit)? = null
    private var stopObserving: (() -> Unit)? = null
    @Volatile private var failure: MediaFailure? = null
    @Volatile private var closed = false
    private val lease = media.acquireUpload(request.id) { stop(MediaFailure(-32003, "Permission denied")) }
    private val handleDeadline = module.elapsedMillis() + lease.remainingMillis()
    private var prepared: File? = null

    fun bind(onStop: (MediaFailure) -> Unit) {
        this.onStop = onStop
        checkGrant()
        // Registration may synchronously notify. Remove a newly returned handle if that notification closed us.
        val remove = module.observeBackground { stop(MediaFailure(-32002, "Cancelled")) }
        if (closed) {
            remove()
            return
        }
        stopObserving = remove
        if (!module.isForeground()) {
            stop(MediaFailure(-32002, "Cancelled"))
            return
        }
        armTimer()
    }

    private fun armTimer() {
        val delay = minOf(deadline - module.elapsedMillis(), lease.remainingMillis()).coerceAtLeast(0)
        val cancel = module.schedule(delay) {
            if (!closed) {
                val error = elapsedFailure()
                if (error == null) armTimer() else stop(error)
            }
        }
        if (closed) cancel() else cancelTimer = cancel
    }

    private fun stop(error: MediaFailure) {
        if (closed || failure != null) return
        val first = elapsedFailure() ?: error
        failure = first
        onStop?.invoke(first)
    }

    /** A delayed UI timer must not allow a later cancellation to mask a deadline that already passed. */
    fun elapsedFailure(): MediaFailure? {
        failure?.let { return it }
        val timedOut = module.elapsedMillis() >= deadline
        val invalidHandle = lease.remainingMillis() <= 0
        if (invalidHandle && (!timedOut || handleDeadline < deadline)) return MediaFailure(-32003, "Permission denied")
        return if (timedOut) MediaFailure(-32001, "Timeout") else null
    }

    private fun checkGrant() {
        if (closed) throw CancellationException("Upload is closed")
        elapsedFailure()?.let { throw it }
    }

    suspend fun run(progress: BusinessProgress): JsonObject {
        checkGrant()
        val confirmed = request.confirm()
        checkGrant()
        if (!confirmed) throw MediaFailure(-32007, "User denied")
        try {
            // Keep ownership even if cancellation races the return from withContext.
            val jpeg = withContext(module.io) {
                val context = currentCoroutineContext()
                val check = {
                    context.ensureActive()
                    checkGrant()
                }
                check()
                module.prepare(lease.file, checkNotNull(lease.file.parentFile), request.maxEdge, request.quality, check)
                    .also(::takePrepared)
            }
            checkGrant()
            val headers = request.requestHeaders()
            checkGrant()
            return deliver(jpeg, headers, progress).also { checkGrant() }
        } finally {
            discardPrepared()
        }
    }

    @Synchronized private fun takePrepared(file: File) {
        if (closed) {
            file.delete()
            throw CancellationException("Upload is closed")
        }
        prepared = file
    }

    @Synchronized private fun discardPrepared() {
        prepared?.delete()
        prepared = null
    }

    private suspend fun deliver(jpeg: File, headers: Map<String, String>, progress: BusinessProgress) = coroutineScope {
        val updates = Channel<Pair<Long, Long>>(Channel.CONFLATED)
        launch {
            for ((sent, total) in updates) {
                checkGrant()
                progress.send(JsonObject().apply {
                    addProperty("sent", sent)
                    addProperty("total", total)
                })
            }
        }
        try {
            withContext(module.io) {
                val context = currentCoroutineContext()
                val check = {
                    context.ensureActive()
                    checkGrant()
                }
                check()
                module.send(request, headers, jpeg, check) { sent, total -> updates.trySend(sent to total) }
            }
        } finally {
            updates.close()
        }
    }

    fun close() {
        if (closed) return
        closed = true
        onStop = null
        discardPrepared()
        lease.close()
        cancelTimer?.invoke()
        stopObserving?.invoke()
        cancelTimer = null
        stopObserving = null
    }
}
