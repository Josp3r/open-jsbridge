package dev.openjsbridge.example

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import dev.openjsbridge.host.AndroidBridge

class MainActivity : Activity() {
    private var webView: WebView? = null
    private var bridge: AndroidBridge? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val demo = WebView(this)
        demo.id = R.id.demo_webview
        demo.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
        }
        demo.webViewClient = object : WebViewClient() {
            override fun onPageCommitVisible(view: WebView, url: String) {
                bridge?.onPageCommitVisible(url)
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                bridge?.onRenderProcessGone()
                bridge = null
                webView = null
                showMessage("WebView 进程已退出。请重新打开示例。")
                view.destroy()
                return true
            }
        }
        val attachment = attachExampleBridge(demo)
        if (attachment == null) {
            demo.destroy()
            showMessage("当前 WebView 缺少消息监听或 document-start 注入能力。请更新 Android System WebView。")
            return
        }

        bridge = attachment
        webView = demo
        setContentView(demo)
        loadExamplePage(demo)
    }

    override fun onDestroy() {
        bridge?.detach()
        bridge = null
        webView?.let {
            setContentView(TextView(this))
            it.destroy()
        }
        webView = null
        super.onDestroy()
    }

    private fun showMessage(message: String) {
        setContentView(TextView(this).apply {
            gravity = Gravity.CENTER
            text = message
        })
    }
}
