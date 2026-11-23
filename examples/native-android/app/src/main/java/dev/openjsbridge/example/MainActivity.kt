package dev.openjsbridge.example

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView

class MainActivity : Activity() {
    private var webView: WebView? = null
    private var bridge: AndroidBridge? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!BuildConfig.DEBUG) {
            showMessage("请运行 debug 构建以使用本地 echo 示例。")
            return
        }

        val demo = WebView(this)
        webView = demo
        demo.id = R.id.demo_webview
        demo.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
        }
        val network = AndroidNetwork(this)
        val attachment = AndroidBridge.attach(demo, AndroidBridge.DEMO_ORIGIN, BridgeModules(
            device = androidDeviceModule(),
            network = network,
            networkEvents = network.events,
        ))
        if (attachment == null) {
            demo.destroy()
            webView = null
            showMessage("当前 WebView 缺少消息监听或 document-start 注入能力。请更新 Android System WebView。")
            return
        }

        bridge = attachment
        demo.webViewClient = object : WebViewClient() {
            override fun onPageCommitVisible(view: WebView, url: String) {
                attachment.onPageCommitVisible(url)
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                attachment.onRenderProcessGone()
                bridge = null
                webView = null
                showMessage("WebView 进程已退出。请重新打开示例。")
                view.destroy()
                return true
            }
        }
        setContentView(demo)
        demo.loadUrl("${AndroidBridge.DEMO_ORIGIN}/?host=native")
    }

    override fun onDestroy() {
        bridge?.detach()
        webView?.let {
            setContentView(TextView(this))
            it.destroy()
        }
        super.onDestroy()
    }

    private fun showMessage(message: String) {
        setContentView(TextView(this).apply {
            gravity = Gravity.CENTER
            text = message
        })
    }
}
