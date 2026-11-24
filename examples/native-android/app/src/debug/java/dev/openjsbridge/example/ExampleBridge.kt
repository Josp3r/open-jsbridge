package dev.openjsbridge.example

import android.view.View
import android.webkit.WebView
import dev.openjsbridge.host.AndroidBridge
import dev.openjsbridge.host.AndroidBridgeDebugDemo

internal fun attachExampleBridge(webView: WebView): AndroidBridge? = AndroidBridgeDebugDemo.attach(
    webView,
    options = AndroidBridge.Options(deviceInfo = true, networkStatus = true, networkChanges = true),
)

internal fun createExampleView(webView: WebView, @Suppress("UNUSED_PARAMETER") bridge: AndroidBridge): View = webView

internal fun loadExamplePage(webView: WebView) {
    webView.loadUrl("${AndroidBridgeDebugDemo.ORIGIN}/?host=native")
}
