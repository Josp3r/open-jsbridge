package dev.openjsbridge.example

import java.net.URI
import java.net.URISyntaxException
import java.util.Locale
import java.util.UUID

/** State for one WebView, confined to the UI thread by AndroidBridge. */
internal class DocumentTransport(
    allowedOrigin: String,
    private val enableEcho: Boolean,
    private val modules: BridgeModules = BridgeModules(),
    private val scheduleReply: (() -> Unit) -> Unit = { reply -> reply() },
) {
    val originRule = requireNotNull(exactOrigin(allowedOrigin)) { "An exact HTTP(S) origin is required" }

    private data class ParkedFrame(val bytes: Int, val action: () -> Unit)

    private class Document(val token: String, val proxy: Any, val session: RpcSession, var challenge: String) {
        val parked = ArrayDeque<ParkedFrame>()
        var parkedBytes = 0
    }

    private var pendingChallenge: String? = null
    private var document: Document? = null

    fun invalidate() {
        pendingChallenge = null
        retireDocument()
    }

    fun onPageCommitVisible(url: String, currentUrl: String? = null): String? {
        // A delayed off-origin callback can arrive after a trusted page becomes current.
        // The URL hint only schedules a challenge; WebMessageListener still verifies the caller.
        if (originOf(parseUri(url)) != originRule && originOf(currentUrl?.let(::parseUri)) != originRule) {
            invalidate()
            return null
        }
        return UUID.randomUUID().toString().also { pendingChallenge = it }
    }

    fun receive(raw: String, sourceOrigin: String, isMainFrame: Boolean, proxy: Any, postReply: (String) -> Unit) {
        if (!isMainFrame || exactOrigin(sourceOrigin) != originRule) return

        val challenge = pendingChallenge
        if (challenge != null && raw.length == COMMIT_LENGTH && raw.startsWith("commit:$challenge:")) {
            val token = raw.takeLast(TOKEN_LENGTH)
            if (!TOKEN_PATTERN.matches(token)) return
            val previous = document
            // A queued commit callback may target a document we already confirmed.
            // Only its original proxy and token may reuse the session and its queue.
            val current = if (previous != null && previous.proxy === proxy && previous.token == token) {
                previous
            } else {
                retireDocument()
                Document(token, proxy, RpcSession(enableEcho, modules), challenge).also { document = it }
            }
            current.challenge = challenge
            pendingChallenge = null
            postReply("ready:$challenge:$token")
            replay(current)
            return
        }

        val current = document ?: return
        if (proxy !== current.proxy) return
        if (raw == "leave:${current.token}") {
            retireDocument()
            return
        }
        val prefix = "rpc:${current.token}:"
        if (raw == "push:${current.challenge}:${current.token}") {
            if (pendingChallenge == null) {
                current.session.confirmEventReceiver { event ->
                    if (document === current && pendingChallenge == null) postReply(prefix + event)
                }
            }
            return
        }
        if (!raw.startsWith(prefix) || raw.length - prefix.length > RpcSession.MAX_MESSAGE_BYTES) return
        val payload = raw.substring(prefix.length)
        whenActive(current, payload) {
            var acknowledge: (() -> Unit)? = null
            val response = current.session.receive(payload) { acknowledge = it } ?: return@whenActive
            var completed = false
            scheduleReply {
                if (!completed) {
                    completed = true
                    whenActive(current, response) {
                        postReply(prefix + response)
                        acknowledge?.invoke()
                    }
                }
            }
        }
    }

    private fun retireDocument() {
        val previous = document
        document = null
        previous?.session?.close()
        previous?.parked?.clear()
    }

    private fun whenActive(current: Document, frame: String, action: () -> Unit) {
        if (document !== current) return
        if (pendingChallenge == null) {
            action()
            return
        }
        if (current.parked.size >= MAX_PARKED_FRAMES) return
        val bytes = frame.toByteArray(Charsets.UTF_8).size
        if (bytes > RpcSession.MAX_MESSAGE_BYTES - current.parkedBytes) return
        current.parked.addLast(ParkedFrame(bytes, action))
        current.parkedBytes += bytes
    }

    private fun replay(current: Document) {
        while (document === current && pendingChallenge == null && current.parked.isNotEmpty()) {
            val frame = current.parked.removeFirst()
            current.parkedBytes -= frame.bytes
            frame.action()
        }
    }

    private companion object {
        const val MAX_PARKED_FRAMES = 8
        const val TOKEN_LENGTH = 32
        const val COMMIT_LENGTH = 7 + 36 + 1 + TOKEN_LENGTH
        val TOKEN_PATTERN = Regex("[a-f0-9]{32}")

        fun parseUri(raw: String): URI? = try {
            URI(raw)
        } catch (_: URISyntaxException) {
            null
        }

        fun exactOrigin(raw: String): String? {
            val uri = parseUri(raw) ?: return null
            if (uri.rawPath !in listOf("", "/") || uri.rawQuery != null || uri.rawFragment != null) return null
            return originOf(uri)
        }

        fun originOf(uri: URI?): String? {
            val scheme = uri?.scheme?.lowercase(Locale.ROOT) ?: return null
            val defaultPort = when (scheme) {
                "http" -> 80
                "https" -> 443
                else -> return null
            }
            val host = uri.host?.lowercase(Locale.ROOT) ?: return null
            if (uri.rawUserInfo != null) return null
            return when (uri.port) {
                -1, defaultPort -> "$scheme://$host"
                in 1..65535 -> "$scheme://$host:${uri.port}"
                else -> null
            }
        }
    }
}
