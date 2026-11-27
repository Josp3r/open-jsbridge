package dev.openjsbridge.host

import android.annotation.SuppressLint
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewFeature
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Verifies `SEC-JSI-DEFAULT-001` on a real Android WebView:
 * when `WEB_MESSAGE_LISTENER` or `DOCUMENT_START_SCRIPT` is unsupported,
 * `AndroidBridge.install` returns `null`, installs no fallback channel, and leaves the bridge unavailable.
 */
@RunWith(AndroidJUnit4::class)
class AndroidChannelFallbackTest {
    @Test
    @SuppressLint("SetJavaScriptEnabled")
    fun installReturnsNullAndInstallsNoFallbackWhenRequiredFeatureIsMissing() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val origin = "https://app.example.test"
        val webViewRef = AtomicReference<WebView>()
        val pageLoaded = CountDownLatch(1)

        try {
            var withoutWml: AndroidBridge? = null
            var withoutDocumentStart: AndroidBridge? = null
            instrumentation.runOnMainSync {
                val webView = WebView(context)
                webViewRef.set(webView)
                webView.settings.javaScriptEnabled = true

                withoutWml = AndroidBridge.install(
                    webView,
                    setOf(origin),
                    isFeatureSupported = { it != WebViewFeature.WEB_MESSAGE_LISTENER },
                )
                // Re-attempting on the same untouched WebView also proves the first rejected install
                // did not register an attachment entry.
                withoutDocumentStart = AndroidBridge.install(
                    webView,
                    setOf(origin),
                    isFeatureSupported = { it != WebViewFeature.DOCUMENT_START_SCRIPT },
                )

                webView.webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView?, url: String?) {
                        if (url == "$origin/") pageLoaded.countDown()
                    }
                }
                webView.loadDataWithBaseURL(
                    "$origin/",
                    "<!doctype html><html><body>ok</body></html>",
                    "text/html",
                    "utf-8",
                    null,
                )
            }

            assertNull("attach/install must return null when WEB_MESSAGE_LISTENER is unsupported", withoutWml)
            assertNull("attach/install must return null when DOCUMENT_START_SCRIPT is unsupported", withoutDocumentStart)
            assertTrue("Timed out waiting for WebView page load", pageLoaded.await(15, TimeUnit.SECONDS))

            val evalResult = AtomicReference<String>()
            val evalDone = CountDownLatch(1)
            instrumentation.runOnMainSync {
                webViewRef.get().evaluateJavascript(
                    "({origin:location.origin,transport:typeof window.__OJSB_TRANSPORT__,wml:typeof window.__ojsb_wml})",
                ) { raw ->
                    evalResult.set(raw)
                    evalDone.countDown()
                }
            }
            assertTrue("Timed out evaluating WebView globals", evalDone.await(5, TimeUnit.SECONDS))

            val snapshot = JsonParser.parseString(evalResult.get()).asJsonObject
            assertEquals(origin, snapshot.get("origin").asString)
            assertEquals("undefined", snapshot.get("transport").asString)
            assertEquals("undefined", snapshot.get("wml").asString)
        } finally {
            instrumentation.runOnMainSync {
                webViewRef.getAndSet(null)?.destroy()
            }
        }
    }

    @Test
    fun installSucceedsAndDetachesCleanlyWhenRequiredFeaturesAreSupported() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        if (!AndroidBridge.hasRequiredWebViewFeatures()) return

        var bridge: AndroidBridge? = null
        val webViewRef = AtomicReference<WebView>()
        try {
            instrumentation.runOnMainSync {
                val webView = WebView(context)
                webViewRef.set(webView)
                bridge = AndroidBridge.install(webView, setOf("https://app.example.test"))
            }
            assertNotNull("Expected AndroidBridge to install when both WebView features are supported", bridge)
        } finally {
            instrumentation.runOnMainSync {
                bridge?.detach()
                webViewRef.getAndSet(null)?.destroy()
            }
        }
    }
}
