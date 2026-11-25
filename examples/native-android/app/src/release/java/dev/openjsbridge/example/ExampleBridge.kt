package dev.openjsbridge.example

import android.content.Context
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.webkit.WebView
import android.widget.Button
import android.widget.LinearLayout
import com.google.gson.JsonObject
import dev.openjsbridge.host.AndroidBridge
import dev.openjsbridge.host.BusinessMethod
import dev.openjsbridge.host.InvalidBusinessParamsException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val TRUSTED_ORIGIN = "https://app.example.test"
private const val CONFIG_CHANGED = "acme.app.configChanged"
private const val THEME_KEY = "theme"

internal fun attachExampleBridge(webView: WebView): AndroidBridge? {
    val context = webView.context.applicationContext
    val getConfig = BusinessMethod("acme.app.getConfig") { params ->
        if (params.size() != 0) throw InvalidBusinessParamsException()
        val theme = withContext(Dispatchers.IO) {
            configPreferences(context).getString(THEME_KEY, null) ?: "system"
        }
        configPayload(theme)
    }
    return AndroidBridge.attach(
        webView,
        allowedOrigins = listOf(TRUSTED_ORIGIN),
        options = AndroidBridge.Options(deviceInfo = true, appLifecycle = true),
        methods = listOf(getConfig),
        events = listOf(CONFIG_CHANGED),
    )
}

internal fun createExampleView(webView: WebView, bridge: AndroidBridge): View {
    val context = webView.context
    val preferences = configPreferences(context)
    val toggle = Button(context).apply {
        id = R.id.demo_toggle_theme
        setText(R.string.demo_toggle_theme)
        setOnClickListener {
            val theme = if (preferences.getString(THEME_KEY, null) == "dark") "light" else "dark"
            preferences.edit().putString(THEME_KEY, theme).apply()
            bridge.emit(CONFIG_CHANGED, configPayload(theme))
        }
    }
    return LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        fitsSystemWindows = true
        addView(toggle, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        addView(webView, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
    }
}

private fun configPreferences(context: Context) = context.getSharedPreferences("app-config", Context.MODE_PRIVATE)

private fun configPayload(theme: String) = JsonObject().apply { addProperty(THEME_KEY, theme) }

internal fun loadExamplePage(webView: WebView) {
    val html = webView.context.assets.open("release-demo.html").bufferedReader().use { it.readText() }
    webView.loadDataWithBaseURL("$TRUSTED_ORIGIN/", html, "text/html", "UTF-8", null)
}
