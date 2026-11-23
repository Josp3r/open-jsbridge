package dev.openjsbridge.example

import android.os.SystemClock
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class MainActivityTest {
    @Test
    fun webDemoEchoesThroughAndroidBeforeAndAfterNavigation() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitScript(scenario, "document.querySelector('#send')?.disabled === false")
            assertEquals("true", evaluate(scenario, "window.__OJSB_TRANSPORT__?.name === 'android-wml'"))
            echo(scenario, "first echo")

            evaluate(scenario, "history.pushState({}, '', '#same-document')")
            echo(scenario, "same-document echo")

            scenario.onActivity { demoWebView(it).reload() }
            awaitScript(scenario, """
                document.querySelector('#connection-status')?.dataset.state === 'idle' &&
                  document.querySelector('#send')?.disabled === false
            """.trimIndent())
            echo(scenario, "echo after reload")
        }
    }

    @Test
    fun iframeAndUnlistedOriginCannotUseTheSdkTransport() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitScript(scenario, "document.querySelector('#send')?.disabled === false")
            evaluate(scenario, """
                const child = document.createElement('iframe');
                child.id = 'frame-test';
                child.src = '/?host=native';
                document.body.appendChild(child);
            """.trimIndent())
            awaitScript(scenario, """
                document.querySelector('#frame-test')?.contentDocument
                  ?.querySelector('#send')?.disabled === false
            """.trimIndent())
            assertEquals("true", evaluate(scenario, """
                typeof document.querySelector('#frame-test').contentWindow.__OJSB_TRANSPORT__ === 'undefined'
            """.trimIndent()))

            scenario.onActivity {
                demoWebView(it).loadDataWithBaseURL(
                    "https://unlisted.invalid/",
                    "<!DOCTYPE html><html><body id='unlisted'>Unlisted origin</body></html>",
                    "text/html",
                    "UTF-8",
                    null,
                )
            }
            awaitScript(scenario, "document.body?.id === 'unlisted'")
            assertEquals("true", evaluate(scenario, """
                typeof window.__OJSB_TRANSPORT__ === 'undefined' &&
                  typeof window.__ojsb_wml === 'undefined'
            """.trimIndent()))
        }
    }

    @Test
    fun deferredEchoDoesNotReachTheReplacementDocument() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val origin = AndroidBridge.DEMO_ORIGIN
            lateinit var bridge: AndroidBridge
            lateinit var webView: WebView
            var deferNextReply: CompletableFuture<() -> Unit>? = null
            scenario.onActivity { activity ->
                webView = WebView(activity).apply {
                    id = R.id.demo_webview
                    settings.javaScriptEnabled = true
                }
                bridge = checkNotNull(AndroidBridge.attach(webView, origin) { reply ->
                    val deferred = deferNextReply
                    deferNextReply = null
                    if (deferred == null) reply() else deferred.complete(reply)
                })
                webView.webViewClient = object : WebViewClient() {
                    override fun onPageCommitVisible(view: WebView, url: String) = bridge.onPageCommitVisible(url)
                }
                activity.setContentView(webView)
                webView.loadUrl("$origin/?host=native&document=first")
            }
            try {
                awaitScript(scenario, "document.querySelector('#send')?.disabled === false")
                echo(scenario, "first document ready")
                val deferred = CompletableFuture<() -> Unit>()
                scenario.onActivity { deferNextReply = deferred }
                sendEcho(scenario, "unique-old-document-marker")
                val completeOldEcho = deferred.get(5, TimeUnit.SECONDS)

                scenario.onActivity {
                    webView.loadUrl("$origin/?host=native&document=intermediate")
                    webView.loadUrl("$origin/?host=native&document=replacement")
                }
                awaitScript(scenario, """
                    location.search.includes('document=replacement') &&
                      document.querySelector('#connection-status')?.dataset.state === 'idle' &&
                      document.querySelector('#send')?.disabled === false
                """.trimIndent())
                evaluate(scenario, """
                    window.nativeReplyFrames = [];
                    window.__ojsb_wml.addEventListener('message', event => window.nativeReplyFrames.push(event.data));
                """.trimIndent())
                echo(scenario, "replacement document ready")

                scenario.onActivity { completeOldEcho() }
                echo(scenario, "unique-new-document-marker")
                assertEquals("true", evaluate(scenario, """
                    window.nativeReplyFrames.some(frame => frame.includes('unique-new-document-marker')) &&
                      !window.nativeReplyFrames.some(frame => frame.includes('unique-old-document-marker'))
                """.trimIndent()))
            } finally {
                scenario.onActivity {
                    bridge.detach()
                    (webView.parent as? ViewGroup)?.removeView(webView)
                    webView.destroy()
                }
            }
        }
    }

    @Test
    fun demoOptInUsesTheAndroidDeviceAndDefaultNetwork() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitScript(scenario, "window.__OJSB_TRANSPORT__?.name === 'android-wml'")
            installWireProbe(scenario)
            assertEquals("true", evaluate(scenario, """
                nativeReplies.hello.result.capabilities.methods['device.getInfo'].versions.join() === '1' &&
                  nativeReplies.hello.result.capabilities.methods['network.getStatus'].versions.join() === '1' &&
                  nativeReplies.hello.result.capabilities.events.includes('network.changed')
            """.trimIndent()))
            evaluate(scenario, """
                window.sendNative('device', 'device.getInfo@1');
                window.sendNative('network', 'network.getStatus', {});
            """.trimIndent())
            awaitScript(scenario, "!!nativeReplies.device && !!nativeReplies.network")
            assertEquals("true", evaluate(scenario, """
                nativeReplies.device.result.os === 'android' && !!nativeReplies.device.result.osVersion &&
                  ['wifi', 'cellular', 'ethernet', 'other', 'none', 'unknown'].includes(nativeReplies.network.result.type)
            """.trimIndent()))
            subscribeWireProbe(scenario)
            evaluate(scenario, "window.sendNative('off', 'bridge.unsubscribe', { events: ['network.changed'] })")
            awaitScript(scenario, "nativeReplies.off?.result?.unsubscribed.includes('network.changed') === true")
        }
    }

    @Test
    fun networkPushReachesOnlyTheSubscribedDocument() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val origin = AndroidBridge.DEMO_ORIGIN
            lateinit var bridge: AndroidBridge
            lateinit var webView: WebView
            val callbacks = mutableListOf<(NetworkType) -> Unit>()
            var stops = 0
            val source = NetworkEvents { onChange ->
                callbacks.add(onChange)
                ({ stops += 1 })
            }
            scenario.onActivity { activity ->
                webView = WebView(activity).apply {
                    id = R.id.demo_webview
                    settings.javaScriptEnabled = true
                }
                bridge = checkNotNull(AndroidBridge.attach(webView, origin, BridgeModules(networkEvents = source)))
                webView.webViewClient = object : WebViewClient() {
                    override fun onPageCommitVisible(view: WebView, url: String) = bridge.onPageCommitVisible(url)
                }
                activity.setContentView(webView)
                webView.loadUrl("$origin/?host=native&document=subscription")
            }
            try {
                awaitScript(scenario, "location.search.includes('document=subscription') && !!window.__OJSB_TRANSPORT__")
                installWireProbe(scenario)
                subscribeWireProbe(scenario)
                scenario.onActivity { callbacks.single()(NetworkType.ETHERNET) }
                awaitScript(scenario, """
                    nativeEvents.some(frame => frame.meta.sid === nativeReplies.hello.result.sid &&
                      frame.rpc.method === 'bridge.event' && frame.rpc.params.name === 'network.changed' &&
                      frame.rpc.params.payload.type === 'ethernet' && !('id' in frame.rpc))
                """.trimIndent())

                evaluate(scenario, "window.sendNative('off', 'bridge.unsubscribe', { events: ['network.changed'] })")
                awaitScript(scenario, "nativeReplies.off?.result?.unsubscribed.includes('network.changed') === true")
                scenario.onActivity {
                    callbacks.single()(NetworkType.NONE)
                    assertEquals(1, stops)
                }
                assertEquals("1", evaluate(scenario, "nativeEvents.length"))
                subscribeWireProbe(scenario, id = "resubscribe")

                scenario.onActivity { webView.loadUrl("$origin/?host=native&document=network-replacement") }
                awaitScript(scenario, "location.search.includes('document=network-replacement') && !!window.__OJSB_TRANSPORT__")
                installWireProbe(scenario)
                subscribeWireProbe(scenario)
                scenario.onActivity {
                    callbacks[1](NetworkType.OTHER)
                    callbacks[2](NetworkType.WIFI)
                    assertEquals(2, stops)
                }
                awaitScript(scenario, "nativeEvents.some(frame => frame.rpc.params.payload.type === 'wifi')")
                assertEquals("true", evaluate(scenario, """
                    nativeEvents.length === 1 && nativeEvents[0].meta.sid === nativeReplies.hello.result.sid &&
                      nativeFrames.filter(frame => frame.includes('network.changed') && frame.includes('bridge.event')).length === 1
                """.trimIndent()))
                scenario.onActivity {
                    bridge.detach()
                    assertEquals(3, stops)
                }
            } finally {
                scenario.onActivity {
                    bridge.detach()
                    (webView.parent as? ViewGroup)?.removeView(webView)
                    webView.destroy()
                }
            }
        }
    }

    private fun installWireProbe(scenario: ActivityScenario<MainActivity>) {
        evaluate(scenario, """
            window.nativeReplies = {};
            window.nativeEvents = [];
            window.nativeFrames = [];
            window.__ojsb_wml.addEventListener('message', event => nativeFrames.push(event.data));
            window.__OJSB_RECEIVE__ = raw => {
                const frame = JSON.parse(raw);
                if (frame.rpc.id) nativeReplies[frame.rpc.id] = frame.rpc;
                else nativeEvents.push(frame);
            };
            window.sendNative = (id, method, params) => {
                const sid = nativeReplies.hello?.result.sid;
                const rpc = {jsonrpc:'2.0', id, method, params};
                window.__OJSB_TRANSPORT__.postMessage(JSON.stringify({jsb: '1.0', rpc, meta: sid ? {sid} : undefined}));
            };
            window.sendNative('hello', 'bridge.hello', {protocols: [1]});
        """.trimIndent())
        awaitScript(scenario, "!!nativeReplies.hello?.result.sid")
    }

    private fun subscribeWireProbe(scenario: ActivityScenario<MainActivity>, id: String = "subscribe") {
        evaluate(scenario, "window.sendNative('$id', 'bridge.subscribe@1', { events: ['network.changed'] })")
        awaitScript(scenario, "nativeReplies['$id']?.result?.subscribed.includes('network.changed') === true")
    }

    private fun echo(scenario: ActivityScenario<MainActivity>, text: String) {
        sendEcho(scenario, text)
        awaitScript(scenario, """
            document.querySelector('#connection-status')?.dataset.platform === 'android' &&
              document.querySelector('#result')?.textContent.includes('$text')
        """.trimIndent())
    }

    private fun sendEcho(scenario: ActivityScenario<MainActivity>, text: String) {
        evaluate(scenario, """
            document.querySelector('#message').value = '$text';
            document.querySelector('#send').click();
        """.trimIndent())
    }

    private fun demoWebView(activity: MainActivity): WebView {
        val view = activity.findViewById<WebView>(R.id.demo_webview)
        assertNotNull("A supported WebView must be installed for the Android example", view)
        return view!!
    }

    private fun evaluate(scenario: ActivityScenario<MainActivity>, script: String): String {
        val value = CompletableFuture<String>()
        scenario.onActivity { activity ->
            demoWebView(activity).evaluateJavascript(script) { value.complete(it) }
        }
        return value.get(3, TimeUnit.SECONDS)
    }

    private fun awaitScript(scenario: ActivityScenario<MainActivity>, script: String) {
        val deadline = SystemClock.elapsedRealtime() + 15_000
        do {
            if (evaluate(scenario, script) == "true") return
            SystemClock.sleep(100)
        } while (SystemClock.elapsedRealtime() < deadline)

        val status = evaluate(scenario, """
            [location.href, document.querySelector('#connection-status')?.textContent,
              document.querySelector('#result')?.textContent]
        """.trimIndent())
        fail("Timed out while evaluating $script. WebView state was $status")
    }
}
