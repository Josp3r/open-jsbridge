package dev.openjsbridge.host

import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.annotation.MainThread
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.gson.JsonElement
import com.google.gson.JsonPrimitive
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import java.util.WeakHashMap
import java.util.concurrent.Executor

/** A bridge attached to an app-owned WebView. Keep it until the WebView is destroyed. */
class AndroidBridge private constructor(
    private var webView: WebView?,
    private val transport: DocumentTransport,
    private var script: ScriptHandler?,
    private val businessScope: CoroutineScope,
) {
    private val originLiteral = JsonPrimitive(transport.originRule).toString()

    /** Enable only the device and network capabilities the app intends to expose. */
    data class Options(
        val deviceInfo: Boolean = false,
        val networkStatus: Boolean = false,
        val networkChanges: Boolean = false,
    )

    /**
     * Submit a registered business event to the current acknowledged subscription, if any.
     * `true` means the notification was submitted to the confirmed route, not that Web received it.
     * Inactive routes, invalid payloads and oversized frames are dropped rather than buffered.
     */
    @MainThread
    fun emit(name: String, payload: JsonElement): Boolean {
        requireUiThread()
        return webView != null && transport.emit(name, payload)
    }

    /** Forward the main-frame commit callback from the app's WebViewClient. */
    @MainThread
    fun onPageCommitVisible(url: String) {
        requireUiThread()
        val webView = webView ?: return
        val challenge = transport.onPageCommitVisible(url, webView.url) ?: return
        // The shim is already installed at document start. This control call
        // proves which injected object is current, without evaluating RPC data.
        webView.evaluateJavascript(
            "if (window.location.origin === $originLiteral) window.__OJSB_ANDROID_COMMIT__?.('$challenge')",
            null,
        )
    }

    /** Forward renderer termination before removing and destroying the affected WebView. */
    @MainThread
    fun onRenderProcessGone() {
        requireUiThread()
        if (webView != null) close()
    }

    /** Retire the document and remove the bridge's hooks before destroying the WebView. */
    @MainThread
    fun detach() {
        requireUiThread()
        val webView = webView ?: return
        val script = script
        try {
            close()
        } finally {
            try {
                script?.remove()
            } finally {
                WebViewCompat.removeWebMessageListener(webView, NATIVE_OBJECT)
                attachments.remove(webView)
            }
        }
    }

    private fun close() {
        webView = null
        script = null
        try {
            transport.invalidate()
        } finally {
            businessScope.cancel()
        }
    }

    companion object {
        private const val NATIVE_OBJECT = "__ojsb_wml"
        private val attachments = WeakHashMap<WebView, Unit>()

        /**
         * Attach before the first navigation, and forward lifecycle callbacks from the app's WebViewClient.
         * Returns `null` when the installed WebView lacks the required message or script support.
         * The app is responsible for enabling JavaScript and loading content from the allowed HTTPS origin.
         * [events] opts in to unique, unversioned business event names, outside reserved namespaces.
         */
        @MainThread
        fun attach(
            webView: WebView,
            allowedOrigin: String,
            options: Options = Options(),
            methods: List<BusinessMethod> = emptyList(),
            events: List<String> = emptyList(),
        ): AndroidBridge? {
            requireUiThread()
            val origin = requireNotNull(DocumentTransport.exactOrigin(allowedOrigin)) {
                "An exact HTTPS origin is required"
            }
            require(origin.startsWith("https://")) { "An exact HTTPS origin is required" }
            val registeredMethods = methods.toList()
            registeredMethods.indexBusinessMethods()
            val registeredEvents = events.toList()
            registeredEvents.indexBusinessEvents()
            return install(webView, origin, modulesFor(webView, options), registeredMethods, events = registeredEvents)
        }

        internal fun modulesFor(webView: WebView, options: Options): BridgeModules {
            val network = if (options.networkStatus || options.networkChanges) AndroidNetwork(webView.context) else null
            return BridgeModules(
                device = if (options.deviceInfo) androidDeviceModule() else null,
                network = if (options.networkStatus) network else null,
                networkEvents = if (options.networkChanges) network?.events else null,
            )
        }

        @MainThread
        internal fun install(
            webView: WebView,
            allowedOrigin: String,
            modules: BridgeModules = BridgeModules(),
            methods: List<BusinessMethod> = emptyList(),
            enableEcho: Boolean = false,
            events: List<String> = emptyList(),
            scheduleReply: (() -> Unit) -> Unit = { it() },
        ): AndroidBridge? {
            requireUiThread()
            check(webView !in attachments) { "A bridge is already attached to this WebView" }
            check(webView.url == null && webView.copyBackForwardList().currentItem == null) {
                "Attach the bridge before navigating the WebView"
            }
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
                !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
            ) return null

            val main = Handler(Looper.getMainLooper())
            val scope = CoroutineScope(SupervisorJob() + Executor { main.post(it) }.asCoroutineDispatcher())
            val transport = DocumentTransport(
                allowedOrigin, enableEcho, modules, businessMethods = methods,
                runBusiness = { call, complete ->
                    val job = scope.launch {
                        val result = try {
                            val value = call.handler(call.params)
                            ensureActive()
                            Result.success(value)
                        } catch (error: Throwable) {
                            if (error is VirtualMachineError || error is ThreadDeath || error is LinkageError) throw error
                            Result.failure(error)
                        }
                        complete(result)
                    }
                    ({ job.cancel() })
                },
                events = events,
                scheduleReply = { reply ->
                    scheduleReply {
                        requireUiThread()
                        reply()
                    }
                },
            )
            val origins = setOf(transport.originRule)
            val source = webView.context.assets.open("open-jsbridge/android-transport.js")
                .bufferedReader(Charsets.UTF_8).use { it.readText() }
            WebViewCompat.addWebMessageListener(webView, NATIVE_OBJECT, origins) { _, message, origin, main, proxy ->
                if (message.type != WebMessageCompat.TYPE_STRING) return@addWebMessageListener
                val raw = message.data ?: return@addWebMessageListener
                transport.receive(raw, origin.toString(), main, proxy) { proxy.postMessage(it) }
            }
            val script = try {
                WebViewCompat.addDocumentStartJavaScript(webView, source, origins)
            } catch (error: RuntimeException) {
                scope.cancel()
                WebViewCompat.removeWebMessageListener(webView, NATIVE_OBJECT)
                throw error
            }
            attachments[webView] = Unit
            return AndroidBridge(webView, transport, script, scope)
        }

        private fun requireUiThread() {
            check(Looper.myLooper() === Looper.getMainLooper()) { "Use the WebView UI thread" }
        }
    }
}
