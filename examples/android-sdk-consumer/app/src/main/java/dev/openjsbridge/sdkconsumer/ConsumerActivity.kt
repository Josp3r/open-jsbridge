package dev.openjsbridge.sdkconsumer

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import dev.openjsbridge.host.AndroidBridge

class ConsumerActivity : Activity() {
    internal var browser: WebView? = null
        private set
    private var bridge: AndroidBridge? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val page = assets.open("ReleaseToast.html").bufferedReader(Charsets.UTF_8).use { it.readText() }
        val view = WebView(this)
        view.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
        }
        view.webViewClient = object : WebViewClient() {
            override fun onPageCommitVisible(view: WebView, url: String) {
                bridge?.onPageCommitVisible(url)
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                bridge?.onRenderProcessGone()
                bridge = null
                browser = null
                showMessage("The WebView renderer exited. Reopen this app to try again.")
                view.destroy()
                return true
            }
        }
        bridge = AndroidBridge.attach(
            view, allowedOrigin = ORIGIN,
            options = AndroidBridge.Options(deviceInfo = true, toast = true),
        )
        if (bridge == null) {
            view.destroy()
            showMessage("Update Android System WebView to use the native bridge.")
            return
        }
        browser = view
        setContentView(view)
        view.loadDataWithBaseURL("$ORIGIN/", page, "text/html", "UTF-8", null)
    }

    override fun onDestroy() {
        bridge?.detach()
        bridge = null
        browser?.let {
            setContentView(TextView(this))
            it.destroy()
        }
        browser = null
        super.onDestroy()
    }

    private fun showMessage(message: String) {
        setContentView(TextView(this).apply { text = message })
    }

    companion object {
        internal const val ORIGIN = "https://sdk-consumer.example.test"
    }
}
