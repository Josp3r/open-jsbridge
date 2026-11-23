package dev.openjsbridge.example

import java.net.URI
import java.net.URISyntaxException
import java.util.Locale
import java.util.UUID

/** State for one WebView, confined to the UI thread by AndroidBridge. */
internal class DocumentTransport(allowedOrigin: String, private val enableEcho: Boolean) {
    val originRule = requireNotNull(exactOrigin(allowedOrigin)) { "An exact HTTP(S) origin is required" }

    private data class Document(val token: String, val proxy: Any, val session: RpcSession)

    private var pendingChallenge: String? = null
    private var document: Document? = null

    fun invalidate() {
        pendingChallenge = null
        document = null
    }

    fun onPageCommitVisible(url: String): String? {
        if (originOf(parseUri(url)) != originRule) {
            invalidate()
            return null
        }
        return UUID.randomUUID().toString().also { pendingChallenge = it }
    }

    fun receive(raw: String, sourceOrigin: String, isMainFrame: Boolean, proxy: Any): String? {
        if (!isMainFrame || exactOrigin(sourceOrigin) != originRule) return null

        val challenge = pendingChallenge
        if (challenge != null && raw.length == COMMIT_LENGTH && raw.startsWith("commit:$challenge:")) {
            val token = raw.takeLast(TOKEN_LENGTH)
            if (!TOKEN_PATTERN.matches(token)) return null
            val previous = document
            // A queued commit callback may confirm a document that has already
            // answered another challenge. Only the same object and token keep
            // their session. The route is suspended until either is confirmed.
            if (previous == null || previous.proxy !== proxy || previous.token != token) {
                document = Document(token, proxy, RpcSession(enableEcho))
            }
            pendingChallenge = null
            return "ready:$challenge:$token"
        }

        val current = document ?: return null
        if (proxy !== current.proxy) return null
        if (raw == "leave:${current.token}") {
            document = null
            return null
        }
        if (pendingChallenge != null) return null
        val prefix = "rpc:${current.token}:"
        if (!raw.startsWith(prefix) || raw.length - prefix.length > RpcSession.MAX_MESSAGE_BYTES) return null
        val response = current.session.receive(raw.substring(prefix.length)) ?: return null
        return prefix + response
    }

    private companion object {
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
