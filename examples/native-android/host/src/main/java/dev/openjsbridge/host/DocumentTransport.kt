package dev.openjsbridge.host

import com.google.gson.JsonElement
import java.net.InetAddress
import java.net.URI
import java.net.URISyntaxException
import java.net.UnknownHostException
import java.util.Locale
import java.util.UUID

/** State for one WebView, confined to the UI thread by AndroidBridge. */
internal class DocumentTransport(
    allowedOrigins: Collection<String>,
    private val enableEcho: Boolean,
    private val modules: BridgeModules = BridgeModules(),
    private val businessMethods: List<BusinessMethod> = emptyList(),
    private val runBusiness: ((RpcSession.BusinessCall, (Result<JsonElement>) -> Unit) -> (() -> Unit))? = null,
    events: List<String> = emptyList(),
    private val scheduleReply: (() -> Unit) -> Unit = { reply -> reply() },
) {
    val originRules = exactOrigins(allowedOrigins)
    private val registeredEvents = events.indexBusinessEvents()

    data class CommitChallenge(val origin: String, val nonce: String)

    private data class ParkedFrame(val bytes: Int, val action: () -> Unit)

    private class BusinessWork(val call: RpcSession.BusinessCall, val reply: (String) -> Unit) {
        var cancel: (() -> Unit)? = null

        fun abort() {
            try {
                call.onCancel?.invoke()
            } finally {
                cancel?.invoke()
            }
        }
    }

    private class Document(
        val origin: String,
        val token: String,
        val proxy: Any,
        val session: RpcSession,
        var challenge: String,
    ) {
        val parked = ArrayDeque<ParkedFrame>()
        var parkedBytes = 0
        var businessWork: BusinessWork? = null
    }

    private var pendingChallenge: CommitChallenge? = null
    private var document: Document? = null

    fun emit(name: String, payload: JsonElement): Boolean {
        if (pendingChallenge != null) return false
        return document?.session?.emit(name, payload) ?: false
    }

    fun invalidate() {
        pendingChallenge = null
        retireDocument()
    }

    fun onPageCommitVisible(url: String, currentUrl: String? = null): CommitChallenge? {
        // A delayed callback may describe a page that is no longer current.
        // The current URL only selects a challenge origin; WebMessageListener verifies the sender.
        val origin = originOf(currentUrl?.let(::parseUri)) ?: originOf(parseUri(url))
        if (origin == null || origin !in originRules) {
            invalidate()
            return null
        }
        if (document?.origin != origin) retireDocument()
        return CommitChallenge(origin, UUID.randomUUID().toString()).also { pendingChallenge = it }
    }

    fun receive(raw: String, sourceOrigin: String, isMainFrame: Boolean, proxy: Any, postReply: (String) -> Unit) {
        if (!isMainFrame) return
        val origin = sourceOrigin.takeIf(originRules::contains)
            ?: exactOrigin(sourceOrigin)?.takeIf(originRules::contains) ?: return

        val challenge = pendingChallenge
        if (challenge != null && raw.length == COMMIT_LENGTH && raw.startsWith("commit:${challenge.nonce}:")) {
            if (challenge.origin != origin) return
            val token = raw.takeLast(TOKEN_LENGTH)
            if (!TOKEN_PATTERN.matches(token)) return
            val previous = document
            // A queued commit callback may target a document we already confirmed.
            // Only its original proxy and token may reuse the session and its queue.
            val current = if (previous != null && previous.origin == origin && previous.proxy === proxy &&
                previous.token == token
            ) {
                previous
            } else {
                retireDocument()
                val session = RpcSession(enableEcho, modules, businessMethods,
                    supportsCancellation = runBusiness != null, businessEvents = registeredEvents)
                Document(origin, token, proxy, session, challenge.nonce).also { document = it }
            }
            current.challenge = challenge.nonce
            pendingChallenge = null
            postReply("ready:${challenge.nonce}:$token")
            replay(current)
            return
        }

        val current = document ?: return
        if (origin != current.origin || proxy !== current.proxy) return
        if (raw == "leave:${current.token}") {
            retireDocument()
            return
        }
        val prefix = "rpc:${current.token}:"
        if (raw == "push:${current.challenge}:${current.token}") {
            if (pendingChallenge == null) {
                val confirmedChallenge = current.challenge
                current.session.confirmEventReceiver { event ->
                    // Same-document reconfirmation keeps the session, but the old push
                    // route is paused until a matching push confirms the new challenge.
                    if (document !== current || pendingChallenge != null || current.challenge != confirmedChallenge) {
                        false
                    } else {
                        try {
                            postReply(prefix + event)
                            true
                        } catch (_: RuntimeException) {
                            false // Best-effort delivery: the WebView route can disappear.
                        }
                    }
                }
            }
            return
        }
        if (!raw.startsWith(prefix) || raw.length - prefix.length > current.session.maxMessageBytes) return
        val payload = raw.substring(prefix.length)
        whenActive(current, payload) {
            var acknowledge: (() -> Unit)? = null
            var businessCall: RpcSession.BusinessCall? = null
            val response = current.session.receive(
                payload,
                businessBusy = current.businessWork != null,
                onBusinessCall = runBusiness?.let { { call -> businessCall = call } },
                onCancellation = { id -> cancelBusiness(current, id) },
                afterResponse = { acknowledge = it },
            )
            if (response != null) {
                reply(current, response, prefix, postReply, acknowledge)
            } else {
                businessCall?.let { startBusiness(current, it, prefix, postReply) }
            }
        }
    }

    private fun startBusiness(
        current: Document,
        call: RpcSession.BusinessCall,
        prefix: String,
        postReply: (String) -> Unit,
    ) {
        val runner = checkNotNull(runBusiness)
        val work = BusinessWork(call) { response -> reply(current, response, prefix, postReply) }
        current.businessWork = work
        work.cancel = runner(call) { result ->
            if (current.businessWork === work) {
                current.businessWork = null
                current.session.finishBusinessCall(call, result)?.let(work.reply)
            }
        }
        if (document !== current) work.abort()
    }

    private fun cancelBusiness(current: Document, requestId: String) {
        val work = current.businessWork ?: return
        if (work.call.id != requestId) return
        val response = current.session.businessCancellationResponse(work.call) ?: return
        current.businessWork = null
        work.abort()
        work.reply(response)
    }

    private fun reply(
        current: Document,
        response: String,
        prefix: String,
        postReply: (String) -> Unit,
        acknowledge: (() -> Unit)? = null,
    ) {
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

    private fun retireDocument() {
        val previous = document
        document = null
        if (previous == null) return
        val work = previous.businessWork
        previous.businessWork = null
        previous.parked.clear()
        try {
            work?.abort()
        } finally {
            previous.session.close()
        }
    }

    private fun whenActive(current: Document, frame: String, action: () -> Unit) {
        if (document !== current) return
        if (pendingChallenge == null) {
            action()
            return
        }
        if (current.parked.size >= MAX_PARKED_FRAMES) return
        val bytes = frame.toByteArray(Charsets.UTF_8).size
        if (bytes > current.session.maxMessageBytes - current.parkedBytes) return
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

    companion object {
        private const val MAX_PARKED_FRAMES = 8
        private const val TOKEN_LENGTH = 32
        private const val COMMIT_LENGTH = 7 + 36 + 1 + TOKEN_LENGTH
        private val TOKEN_PATTERN = Regex("[a-f0-9]{32}")
        private val IPV4_OCTET = Regex("0|[1-9][0-9]{0,2}")

        private fun parseUri(raw: String): URI? = try {
            URI(raw)
        } catch (_: URISyntaxException) {
            null
        }

        fun exactOrigins(origins: Collection<String>): Set<String> {
            require(origins.isNotEmpty()) { "At least one exact origin is required" }
            return origins.mapTo(linkedSetOf()) { origin ->
                requireNotNull(exactOrigin(origin)) { "An exact HTTP(S) origin is required" }
            }
        }

        fun exactOrigin(raw: String): String? {
            val uri = parseUri(raw) ?: return null
            if (uri.rawPath !in listOf("", "/") || uri.rawQuery != null || uri.rawFragment != null) return null
            return originOf(uri)
        }

        private fun originOf(uri: URI?): String? {
            val scheme = uri?.scheme?.lowercase(Locale.ROOT) ?: return null
            val defaultPort = when (scheme) {
                "http" -> 80
                "https" -> 443
                else -> return null
            }
            if (uri.rawUserInfo != null || uri.rawAuthority?.endsWith(':') == true) return null
            val host = normalizeHost(uri.host?.lowercase(Locale.ROOT) ?: return null) ?: return null
            return when (uri.port) {
                -1, defaultPort -> "$scheme://$host"
                in 1..65535 -> "$scheme://$host:${uri.port}"
                else -> null
            }
        }

        private fun normalizeHost(host: String): String? {
            if (host.startsWith('[')) return serializeIpv6(host)
            val lastLabel = host.removeSuffix(".").substringAfterLast('.')
            val looksNumeric = lastLabel.all { it in '0'..'9' } ||
                (lastLabel.startsWith("0x") && lastLabel.drop(2).all { it in '0'..'9' || it in 'a'..'f' })
            if (looksNumeric) {
                val octets = host.split('.')
                if (octets.size != 4 || octets.any { !IPV4_OCTET.matches(it) || it.toInt() > 255 }) return null
            }
            return host
        }

        private fun serializeIpv6(host: String): String? {
            if ('%' in host) return null
            // URI has already parsed a bracketed numeric IPv6 literal. No DNS is needed.
            val address = try {
                InetAddress.getByName(host).address
            } catch (_: UnknownHostException) {
                return null
            }
            // InetAddress can return four bytes for an IPv4-mapped IPv6 literal.
            val bytes = if (address.size == 4) ByteArray(10) + byteArrayOf(-1, -1) + address else address
            val groups = List(8) { index ->
                val high = bytes[index * 2].toInt() and 0xff
                val low = bytes[index * 2 + 1].toInt() and 0xff
                ((high shl 8) or low).toString(16)
            }
            var runLength = 0
            var longest = 1
            var start = 0
            for ((index, group) in groups.withIndex()) {
                runLength = if (group == "0") runLength + 1 else 0
                if (runLength > longest) {
                    longest = runLength
                    start = index - longest + 1
                }
            }
            if (longest == 1) return groups.joinToString(":", "[", "]")
            val left = groups.take(start).joinToString(":")
            val right = groups.drop(start + longest).joinToString(":")
            return "[$left::$right]"
        }
    }
}
