package dev.openjsbridge.sdkconsumer

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import dev.openjsbridge.host.AndroidBridge
import dev.openjsbridge.host.AndroidMediaPicker

class ConsumerActivity : ComponentActivity() {
    internal var browser: WebView? = null
        private set
    private var bridge: AndroidBridge? = null
    private var mediaPicker: AndroidMediaPicker? = null
    private val photoPickerContract = ActivityResultContracts.PickVisualMedia()

    // The app owns registration and launch; the SDK only receives this picker result.
    private val pickImage = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        mediaPicker?.onResult(photoPickerContract.parseResult(result.resultCode, result.data))
    }

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
        val picker = if (AndroidMediaPicker.isAvailable(this)) {
            AndroidMediaPicker {
                val intent = checkNotNull(AndroidMediaPicker.createIntent(this)) { "System Photo Picker unavailable" }
                pickImage.launch(intent)
            }
        } else null
        mediaPicker = picker
        bridge = AndroidBridge.attach(
            view, allowedOrigins = listOf(ORIGIN),
            options = AndroidBridge.Options(deviceInfo = true, toast = true, media = picker != null),
            mediaPicker = picker,
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
        mediaPicker = null
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
