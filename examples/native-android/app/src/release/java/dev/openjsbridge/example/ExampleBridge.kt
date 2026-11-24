package dev.openjsbridge.example

import android.content.Context
import android.webkit.WebView
import com.google.gson.JsonObject
import dev.openjsbridge.host.AndroidBridge
import dev.openjsbridge.host.BusinessMethod
import dev.openjsbridge.host.InvalidBusinessParamsException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val TRUSTED_ORIGIN = "https://app.example.test"

internal fun attachExampleBridge(webView: WebView): AndroidBridge? {
    val context = webView.context.applicationContext
    val getConfig = BusinessMethod("acme.app.getConfig") { params ->
        if (params.size() != 0) throw InvalidBusinessParamsException()
        val theme = withContext(Dispatchers.IO) {
            context.getSharedPreferences("app-config", Context.MODE_PRIVATE)
                .getString("theme", null) ?: "system"
        }
        JsonObject().apply { addProperty("theme", theme) }
    }
    return AndroidBridge.attach(
        webView,
        allowedOrigin = TRUSTED_ORIGIN,
        options = AndroidBridge.Options(deviceInfo = true),
        methods = listOf(getConfig),
    )
}

internal fun loadExamplePage(webView: WebView) {
    val html = webView.context.assets.open("release-demo.html").bufferedReader().use { it.readText() }
    webView.loadDataWithBaseURL("$TRUSTED_ORIGIN/", html, "text/html", "UTF-8", null)
}
