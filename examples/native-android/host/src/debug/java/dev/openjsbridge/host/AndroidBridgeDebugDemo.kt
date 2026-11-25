package dev.openjsbridge.host

import android.webkit.WebView
import androidx.annotation.MainThread

/** Loopback and conformance hooks for the Debug example app. */
object AndroidBridgeDebugDemo {
    const val ORIGIN = "http://10.0.2.2:4173"

    @MainThread
    fun attach(
        webView: WebView,
        options: AndroidBridge.Options = AndroidBridge.Options(),
        scheduleReply: (() -> Unit) -> Unit = { it() },
    ): AndroidBridge? = AndroidBridge.install(
        webView, setOf(ORIGIN), AndroidBridge.modulesFor(webView, options), enableEcho = true,
        scheduleReply = scheduleReply,
    )

    @MainThread
    fun attachNetworkProbe(webView: WebView, observe: ((String) -> Unit) -> (() -> Unit)?): AndroidBridge? {
        val events = NetworkEvents { onChange ->
            observe { name -> onChange(NetworkType.entries.first { it.wireName == name }) }
        }
        return AndroidBridge.install(webView, setOf(ORIGIN), BridgeModules(networkEvents = events), enableEcho = true)
    }
}
