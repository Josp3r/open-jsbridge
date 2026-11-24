package dev.openjsbridge.example

import android.annotation.SuppressLint
import android.content.pm.ApplicationInfo
import android.os.SystemClock
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.gson.JsonObject
import dev.openjsbridge.host.AndroidBridge
import dev.openjsbridge.host.BusinessMethod
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

@RunWith(AndroidJUnit4::class)
class ReleaseActivityTest {
    @Test
    fun releaseAppDisplaysDeviceAndBusinessResults() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity {
                assertFalse(it.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
            }
            awaitScript(scenario, "['ready', 'error'].includes(document.querySelector('#bridge-results')?.dataset.state)")
            val results = "JSON.parse(document.querySelector('#bridge-results').textContent)"
            assertEquals(
                evaluate(scenario, "document.querySelector('#bridge-results').textContent"),
                "\"ready\"", evaluate(scenario, "document.querySelector('#bridge-results').dataset.state"),
            )
            assertEquals("\"$ORIGIN\"", evaluate(scenario, "location.origin"))
            assertEquals("\"android\"", evaluate(scenario, "$results.device.os"))
            assertEquals("true", evaluate(scenario, "typeof $results.device.osVersion === 'string' && $results.device.osVersion.length > 0"))
            assertEquals("\"system\"", evaluate(scenario, "$results.config.theme"))
        }
    }

    @Test
    fun releaseHandshakeAdvertisesDeviceAndBusinessWithoutEcho() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitScript(scenario, "document.querySelector('#bridge-results')?.dataset.state === 'ready'")
            hello(scenario, "/")
            assertEquals("true", evaluate(scenario, """
                (() => {
                    const { methods } = nativeReplies['probe-hello'].result.capabilities;
                    return methods['device.getInfo'].versions.join() === '1' &&
                      methods['acme.app.getConfig'].versions.join() === '1' &&
                      !('conformance.echo' in methods);
                })()
            """.trimIndent()))
            evaluate(scenario, "window.sendNative('invalid-config', 'acme.app.getConfig', {unexpected: true})")
            awaitScript(scenario, "nativeReplies['invalid-config']?.error?.code === -32602")
        }
    }

    @Test
    fun differentHttpsPortCannotUseBridge() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitScript(scenario, "document.querySelector('#bridge-results')?.dataset.state === 'ready'")
            scenario.onActivity { loadPage(findWebView(it), "$ORIGIN:444/") }

            awaitScript(scenario, "document.body?.id === 'probe'")
            assertEquals("\"$ORIGIN:444\"", evaluate(scenario, "location.origin"))
            assertEquals("true", evaluate(scenario, """
                typeof window.__OJSB_TRANSPORT__ === 'undefined' &&
                  typeof window.__ojsb_wml === 'undefined'
            """.trimIndent()))
        }
    }

    @Test
    @SuppressLint("SetJavaScriptEnabled")
    fun replacementDocumentDoesNotReceiveSuspendedBusinessReply() {
        val started = CompletableFuture<Continuation<Unit>>()
        val canceled = CompletableFuture<Boolean>()
        val config = BusinessMethod("acme.app.getConfig") { params ->
            val hold = params.get("hold")?.asBoolean == true
            if (hold) {
                suspendCoroutine<Unit> { continuation -> started.complete(continuation) }
                canceled.complete(!currentCoroutineContext().isActive)
            }
            JsonObject().apply { addProperty("source", if (hold) "old" else "current") }
        }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var testView: WebView
            lateinit var attachment: AndroidBridge
            var resumed = false
            scenario.onActivity { activity ->
                testView = WebView(activity).apply {
                    id = R.id.demo_webview
                    settings.javaScriptEnabled = true
                    webViewClient = object : WebViewClient() {
                        override fun onPageCommitVisible(view: WebView, url: String) {
                            attachment.onPageCommitVisible(url)
                        }
                    }
                }
                attachment = checkNotNull(AndroidBridge.attach(testView, ORIGIN, methods = listOf(config)))
                activity.setContentView(testView)
                loadPage(testView, "$ORIGIN/first")
            }
            try {
                val firstSid = hello(scenario, "/first")
                evaluate(scenario, "window.sendNative('held', 'acme.app.getConfig', {hold: true})")
                val continuation = started.get(5, TimeUnit.SECONDS)

                scenario.onActivity { loadPage(testView, "$ORIGIN/replacement") }
                assertNotEquals(firstSid, hello(scenario, "/replacement"))

                scenario.onActivity {
                    resumed = true
                    continuation.resume(Unit)
                }
                assertTrue("Navigation must cancel the suspended business handler", canceled.get(5, TimeUnit.SECONDS))
                evaluate(scenario, "window.sendNative('current', 'acme.app.getConfig@1', {})")
                awaitScript(scenario, "nativeReplies.current?.result.source === 'current'")
                assertEquals("false", evaluate(scenario, "'held' in nativeReplies"))
            } finally {
                scenario.onActivity {
                    attachment.detach()
                    if (!resumed) started.getNow(null)?.resume(Unit)
                    (testView.parent as? ViewGroup)?.removeView(testView)
                    testView.destroy()
                }
            }
        }
    }

    private fun hello(scenario: ActivityScenario<MainActivity>, path: String): String {
        awaitScript(scenario, "location.pathname === '$path' && !!window.__OJSB_TRANSPORT__")
        evaluate(scenario, """
            window.nativeReplies = {};
            window.__OJSB_RECEIVE__ = raw => {
                const { rpc } = JSON.parse(raw);
                nativeReplies[rpc.id] = rpc;
            };
            window.sendNative = (id, method, params) => {
                const sid = nativeReplies['probe-hello']?.result.sid;
                const rpc = { jsonrpc: '2.0', id, method, params };
                window.__OJSB_TRANSPORT__.postMessage(JSON.stringify({ jsb: '1.0', rpc, meta: sid ? { sid } : undefined }));
            };
            window.sendNative('probe-hello', 'bridge.hello', { protocols: [1] });
        """.trimIndent())
        awaitScript(scenario, "!!nativeReplies['probe-hello']?.result.sid")
        return evaluate(scenario, "nativeReplies['probe-hello'].result.sid")
    }

    private fun loadPage(webView: WebView, baseUrl: String) {
        webView.loadDataWithBaseURL(baseUrl, "<!doctype html><body id=probe></body>", "text/html", "UTF-8", null)
    }

    private fun findWebView(activity: MainActivity): WebView =
        checkNotNull(activity.findViewById<WebView>(R.id.demo_webview)) { "The Release app must mount a supported WebView" }

    private fun evaluate(scenario: ActivityScenario<MainActivity>, script: String): String {
        val result = CompletableFuture<String>()
        scenario.onActivity { findWebView(it).evaluateJavascript(script) { result.complete(it) } }
        return result.get(3, TimeUnit.SECONDS)
    }

    private fun awaitScript(scenario: ActivityScenario<MainActivity>, script: String) {
        val deadline = SystemClock.elapsedRealtime() + 15_000
        do {
            if (evaluate(scenario, script) == "true") return
            SystemClock.sleep(100)
        } while (SystemClock.elapsedRealtime() < deadline)
        val status = evaluate(scenario, "[location.href, document.querySelector('#bridge-results')?.textContent]")
        fail("Timed out while evaluating $script. WebView state was $status")
    }

    private companion object {
        const val ORIGIN = "https://app.example.test"
    }
}
