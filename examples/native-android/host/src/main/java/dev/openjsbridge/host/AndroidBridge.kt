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
import kotlinx.coroutines.withContext
import java.util.WeakHashMap
import java.util.concurrent.Executor

/** A bridge attached to an app-owned WebView. Keep it until the WebView is destroyed. */
class AndroidBridge private constructor(
    private var webView: WebView?,
    private val transport: DocumentTransport,
    private var script: ScriptHandler?,
    private val businessScope: CoroutineScope,
) {
    /** Enable only the standard capabilities the app intends to expose. */
    data class Options(
        val deviceInfo: Boolean = false,
        val networkStatus: Boolean = false,
        val networkChanges: Boolean = false,
        val toast: Boolean = false,
        val media: Boolean = false,
        val appLifecycle: Boolean = false,
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
        val origin = JsonPrimitive(challenge.origin).toString()
        // The shim is already installed at document start. This control call
        // proves which injected object is current, without evaluating RPC data.
        webView.evaluateJavascript(
            "if (window.location.origin === $origin) window.__OJSB_ANDROID_COMMIT__?.('${challenge.nonce}')",
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
         * The app enables JavaScript and supplies the exact HTTPS origins that may use this bridge.
         * [events] opts in to unique, unversioned business event names, outside reserved namespaces.
         * Media requires [Options.media], an app-owned [mediaPicker], and the system Photo Picker.
         */
        @MainThread
        fun attach(
            webView: WebView,
            allowedOrigins: Collection<String>,
            options: Options = Options(),
            methods: List<BusinessMethod> = emptyList(),
            events: List<String> = emptyList(),
            mediaPicker: AndroidMediaPicker? = null,
        ): AndroidBridge? = attach(webView, allowedOrigins, options, methods, events, mediaPicker, uploadPolicy = null)

        /** Enable foreground uploads to the endpoints registered for each trusted origin. */
        @MainThread
        fun attach(
            webView: WebView,
            allowedOrigins: Collection<String>,
            options: Options = Options(),
            methods: List<BusinessMethod> = emptyList(),
            events: List<String> = emptyList(),
            mediaPicker: AndroidMediaPicker? = null,
            uploadPolicy: TransferUploadPolicy?,
        ): AndroidBridge? {
            requireUiThread()
            val origins = DocumentTransport.exactOrigins(allowedOrigins)
            val registeredMethods = methods.toList()
            registeredMethods.indexBusinessMethods()
            val registeredEvents = events.toList()
            registeredEvents.indexBusinessEvents()
            return install(webView, origins, modulesFor(webView, options, mediaPicker, uploadPolicy), registeredMethods,
                events = registeredEvents)
        }

        /** Attach to a single exact HTTPS origin. */
        @MainThread
        fun attach(
            webView: WebView,
            allowedOrigin: String,
            options: Options = Options(),
            methods: List<BusinessMethod> = emptyList(),
            events: List<String> = emptyList(),
            mediaPicker: AndroidMediaPicker? = null,
        ): AndroidBridge? = attach(webView, listOf(allowedOrigin), options, methods, events, mediaPicker)

        @MainThread
        fun attach(
            webView: WebView,
            allowedOrigin: String,
            options: Options = Options(),
            methods: List<BusinessMethod> = emptyList(),
            events: List<String> = emptyList(),
            mediaPicker: AndroidMediaPicker? = null,
            uploadPolicy: TransferUploadPolicy?,
        ): AndroidBridge? = attach(webView, listOf(allowedOrigin), options, methods, events, mediaPicker, uploadPolicy)

        internal fun modulesFor(
            webView: WebView,
            options: Options,
            mediaPicker: AndroidMediaPicker? = null,
            uploadPolicy: TransferUploadPolicy? = null,
        ): BridgeModules {
            val network = if (options.networkStatus || options.networkChanges) AndroidNetwork(webView.context) else null
            return BridgeModules(
                device = if (options.deviceInfo) androidDeviceModule() else null,
                network = if (options.networkStatus) network else null,
                networkEvents = if (options.networkChanges) network?.events else null,
                toast = if (options.toast) androidToastModule(webView.context) else null,
                appLifecycle = if (options.appLifecycle) androidAppLifecycleEvents() else null,
                upload = uploadPolicy?.takeIf {
                    webView.context.checkSelfPermission(android.Manifest.permission.INTERNET) ==
                        android.content.pm.PackageManager.PERMISSION_GRANTED
                }?.let(::androidTransferUpload),
                media = if (options.media && mediaPicker != null && AndroidMediaPicker.isAvailable(webView.context)) {
                    mediaPicker.module(webView.context)
                } else null,
            )
        }

        internal fun hasRequiredWebViewFeatures(
            isFeatureSupported: (String) -> Boolean = { WebViewFeature.isFeatureSupported(it) },
        ): Boolean = isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
            isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)

        @MainThread
        internal fun install(
            webView: WebView,
            canonicalOrigins: Set<String>,
            modules: BridgeModules = BridgeModules(),
            methods: List<BusinessMethod> = emptyList(),
            enableEcho: Boolean = false,
            events: List<String> = emptyList(),
            scheduleReply: (() -> Unit) -> Unit = { it() },
            isFeatureSupported: (String) -> Boolean = { WebViewFeature.isFeatureSupported(it) },
        ): AndroidBridge? {
            requireUiThread()
            check(webView !in attachments) { "A bridge is already attached to this WebView" }
            check(webView.url == null && webView.copyBackForwardList().currentItem == null) {
                "Attach the bridge before navigating the WebView"
            }
            if (!hasRequiredWebViewFeatures(isFeatureSupported)) return null

            val main = Handler(Looper.getMainLooper())
            val webViewDispatcher = Executor { main.post(it) }.asCoroutineDispatcher()
            val scope = CoroutineScope(SupervisorJob() + webViewDispatcher)
            val transport = DocumentTransport(
                canonicalOrigins, enableEcho, modules, businessMethods = methods,
                runBusiness = { call, complete ->
                    val job = scope.launch {
                        val result = try {
                            val route = call.progress
                            val value = call.handler { chunk ->
                                withContext(webViewDispatcher) { route.send(chunk) }
                            }
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
            val origins = transport.originRules
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
