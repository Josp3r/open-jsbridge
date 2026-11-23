package dev.openjsbridge.example

import android.os.Looper
import android.webkit.WebView
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.gson.JsonPrimitive

/** Attach to a single WebView before loading its first document. */
internal class AndroidBridge private constructor(
    private val webView: WebView,
    private val transport: DocumentTransport,
    private val script: ScriptHandler,
) {
    private var closed = false
    private val originLiteral = JsonPrimitive(transport.originRule).toString()

    /** Forward the main-frame commit callback from the app's WebViewClient. */
    fun onPageCommitVisible(url: String) {
        requireUiThread()
        if (closed) return
        val challenge = transport.onPageCommitVisible(url) ?: return
        // The shim is already installed at document start. This control call
        // proves which injected object is current, without evaluating RPC data.
        webView.evaluateJavascript(
            "if (window.location.origin === $originLiteral) window.__OJSB_ANDROID_COMMIT__?.('$challenge')",
            null,
        )
    }

    fun onRenderProcessGone() {
        requireUiThread()
        // The WebView can no longer be used, so the Activity will destroy it.
        closed = true
        transport.invalidate()
    }

    fun detach() {
        requireUiThread()
        if (closed) return
        closed = true
        transport.invalidate()
        script.remove()
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.removeWebMessageListener(webView, NATIVE_OBJECT)
        }
    }

    companion object {
        const val DEMO_ORIGIN = "http://10.0.2.2:4173"
        private const val NATIVE_OBJECT = "__ojsb_wml"

        fun attach(webView: WebView, allowedOrigin: String): AndroidBridge? {
            requireUiThread()
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
                !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
            ) return null

            val transport = DocumentTransport(allowedOrigin, enableEcho = BuildConfig.DEBUG)
            require(transport.originRule.startsWith("https://") ||
                (BuildConfig.DEBUG && transport.originRule == DEMO_ORIGIN)
            ) { "Use HTTPS outside the local Android demo" }
            val origins = setOf(transport.originRule)
            val source = webView.context.assets.open("android-transport.js")
                .bufferedReader(Charsets.UTF_8).use { it.readText() }
            WebViewCompat.addWebMessageListener(webView, NATIVE_OBJECT, origins) { _, message, origin, main, proxy ->
                if (message.type != WebMessageCompat.TYPE_STRING) return@addWebMessageListener
                val raw = message.data ?: return@addWebMessageListener
                transport.receive(raw, origin.toString(), main, proxy)?.let { proxy.postMessage(it) }
            }
            val script = try {
                WebViewCompat.addDocumentStartJavaScript(webView, source, origins)
            } catch (error: RuntimeException) {
                WebViewCompat.removeWebMessageListener(webView, NATIVE_OBJECT)
                throw error
            }
            return AndroidBridge(webView, transport, script)
        }

        private fun requireUiThread() {
            check(Looper.myLooper() === Looper.getMainLooper()) { "Use the WebView UI thread" }
        }
    }
}
