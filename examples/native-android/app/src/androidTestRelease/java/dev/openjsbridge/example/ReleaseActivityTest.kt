package dev.openjsbridge.example

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.SystemClock
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import dev.openjsbridge.host.AndroidBridge
import dev.openjsbridge.host.BusinessMethod
import kotlinx.coroutines.awaitCancellation
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
            val theme = configPreferences().getString("theme", null) ?: "system"
            assertEquals(JsonPrimitive(theme).toString(), evaluate(scenario, "$results.config.theme"))
        }
    }

    @Test
    fun nativeThemeToggleUpdatesTheReleasePage() {
        val preferences = configPreferences()
        val originalTheme = preferences.getString("theme", null)
        val expectedTheme = if (originalTheme == "dark") "light" else "dark"
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                awaitScript(scenario, "document.querySelector('#bridge-results')?.dataset.state === 'ready'")
                scenario.onActivity { activity ->
                    val toggle = checkNotNull(activity.findViewById<Button>(R.id.demo_toggle_theme))
                    assertTrue(toggle.performClick())
                }
                awaitScript(scenario, """
                    document.querySelector('#config-event')?.textContent === '$CONFIG_CHANGED: $expectedTheme' &&
                      JSON.parse(document.querySelector('#bridge-results').textContent).config.theme === '$expectedTheme'
                """.trimIndent())
                assertEquals(expectedTheme, preferences.getString("theme", null))
            }
        } finally {
            // Restores the prior value, or removes the key if it had no value.
            assertTrue(preferences.edit().putString("theme", originalTheme).commit())
        }
    }

    @Test
    fun releaseHandshakeAdvertisesDeviceAndBusinessWithoutEcho() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitScript(scenario, "document.querySelector('#bridge-results')?.dataset.state === 'ready'")
            hello(scenario, "/")
            assertEquals("true", evaluate(scenario, """
                (() => {
                    const { methods, events } = nativeReplies['probe-hello'].result.capabilities;
                    return methods['device.getInfo'].versions.join() === '1' &&
                      methods['acme.app.getConfig'].versions.join() === '1' &&
                      events.length === 3 && events.includes('$CONFIG_CHANGED') &&
                      events.includes('app.foregrounded') && events.includes('app.backgrounded') &&
                      !('conformance.echo' in methods);
                })()
            """.trimIndent()))
            evaluate(scenario, "window.sendNative('invalid-config', 'acme.app.getConfig', {unexpected: true})")
            awaitScript(scenario, "nativeReplies['invalid-config']?.error?.code === -32602")
        }
    }

    @Test
    fun lifecycleSubscriptionDoesNotReplayTheCurrentForegroundState() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            awaitScript(scenario, "document.querySelector('#bridge-results')?.dataset.state === 'ready'")
            hello(scenario, "/")
            evaluate(scenario, """
                window.sendNative('lifecycle', 'bridge.subscribe@1', {events: ['app.foregrounded', 'app.backgrounded']})
            """.trimIndent())
            awaitScript(scenario, """
                nativeReplies.lifecycle?.result?.subscribed?.slice().sort().join() === 'app.backgrounded,app.foregrounded' &&
                  nativeReplies.lifecycle?.result?.denied?.length === 0
            """.trimIndent())

            awaitDeviceRoundTrip(scenario)
            assertEquals("0", evaluate(scenario, "nativeEvents.length"))
        }
    }

    @Test
    fun unregisteredBusinessEventIsDeniedAndCannotBeEmitted() {
        withEventProbe { scenario, webView, attachment ->
            scenario.onActivity { loadPage(webView, "$ORIGIN/unregistered") }
            hello(scenario, "/unregistered")
            assertEquals("0", evaluate(scenario, "nativeReplies['probe-hello'].result.capabilities.events.length"))

            evaluate(scenario, "window.sendNative('subscribe', 'bridge.subscribe', {events: ['$CONFIG_CHANGED']})")
            awaitScript(scenario, """
                nativeReplies.subscribe?.result?.subscribed?.length === 0 &&
                  nativeReplies.subscribe?.result?.denied?.join() === '$CONFIG_CHANGED'
            """.trimIndent())
            scenario.onActivity { assertFalse(attachment.emit(CONFIG_CHANGED, JsonNull.INSTANCE)) }
            awaitDeviceRoundTrip(scenario)
            assertEquals("0", evaluate(scenario, "nativeEvents.length"))
        }
    }

    @Test
    fun businessEventRequiresAConfirmedSubscriptionInTheCurrentReleaseDocument() {
        val firstCommit = CompletableFuture<String>()
        var forwardCommits = false
        withEventProbe(
            events = listOf(CONFIG_CHANGED),
            shouldForwardCommit = { url ->
                if (!forwardCommits) firstCommit.complete(url)
                forwardCommits
            },
        ) { scenario, webView, attachment ->
            scenario.onActivity { loadPage(webView, "$ORIGIN/events-first") }
            startHello(scenario, "/events-first")
            val commitUrl = firstCommit.get(5, TimeUnit.SECONDS)
            assertEquals("false", evaluate(scenario, "'probe-hello' in nativeReplies"))
            scenario.onActivity {
                assertFalse("Emit before forwarding the first commit", attachment.emit(CONFIG_CHANGED, JsonNull.INSTANCE))
                forwardCommits = true
                attachment.onPageCommitVisible(commitUrl)
            }
            val firstSid = awaitHello(scenario)
            scenario.onActivity {
                assertFalse("Emit before subscribing", attachment.emit(CONFIG_CHANGED, JsonNull.INSTANCE))
            }

            subscribe(scenario)
            val payload = JsonParser.parseString("""{"theme":"dark","details":{"changes":[true,null,2,"native"]}}""")
            scenario.onActivity { assertTrue(attachment.emit(CONFIG_CHANGED, payload)) }
            assertEvent(scenario, firstSid, payload)

            evaluate(scenario, "window.sendNative('off', 'bridge.unsubscribe@1', {events: ['$CONFIG_CHANGED']})")
            awaitScript(scenario, "nativeReplies.off?.result?.unsubscribed?.join() === '$CONFIG_CHANGED'")
            scenario.onActivity {
                assertFalse("Emit after unsubscribe", attachment.emit(CONFIG_CHANGED, JsonNull.INSTANCE))
            }
            subscribe(scenario, id = "resubscribe")
            assertEquals("1", evaluate(scenario, "nativeEvents.length"))

            // Leave the old page subscribed so a leaked subscription would affect the replacement.
            scenario.onActivity { loadPage(webView, "$ORIGIN/events-replacement") }
            val replacementSid = hello(scenario, "/events-replacement")
            assertNotEquals(firstSid, replacementSid)
            scenario.onActivity {
                assertFalse("Replacement must subscribe again", attachment.emit(CONFIG_CHANGED, JsonNull.INSTANCE))
            }
            evaluate(scenario, """
                window.sendNative('stale', 'bridge.subscribe', {events: ['$CONFIG_CHANGED']}, ${JsonPrimitive(firstSid)})
            """.trimIndent())
            awaitDeviceRoundTrip(scenario)
            assertEquals("false", evaluate(scenario, "'stale' in nativeReplies"))
            scenario.onActivity {
                assertFalse("Stale SID must not subscribe", attachment.emit(CONFIG_CHANGED, JsonNull.INSTANCE))
            }

            subscribe(scenario)
            val replacementPayload = JsonPrimitive("replacement")
            scenario.onActivity { assertTrue(attachment.emit(CONFIG_CHANGED, replacementPayload)) }
            assertEvent(scenario, replacementSid, replacementPayload)
        }
    }

    @Test
    fun crossingAllowedOriginsReplacesTheSessionAndAnUnlistedOriginHasNoTransport() {
        withEventProbe(
            events = listOf(CONFIG_CHANGED),
            allowedOrigins = listOf(ORIGIN, SECOND_ORIGIN),
        ) { scenario, webView, attachment ->
            scenario.onActivity { loadPage(webView, "$ORIGIN/first-origin") }
            val firstSid = hello(scenario, "/first-origin")
            assertEquals(JsonPrimitive(ORIGIN).toString(), evaluate(scenario, "location.origin"))
            awaitDeviceRoundTrip(scenario)
            subscribe(scenario)

            scenario.onActivity { loadPage(webView, "$SECOND_ORIGIN/second-origin") }
            val secondSid = hello(scenario, "/second-origin")
            assertEquals(JsonPrimitive(SECOND_ORIGIN).toString(), evaluate(scenario, "location.origin"))
            assertNotEquals(firstSid, secondSid)
            scenario.onActivity { assertFalse(attachment.emit(CONFIG_CHANGED, JsonNull.INSTANCE)) }
            evaluate(scenario, """
                window.sendNative('prior-origin', 'bridge.subscribe', {events: ['$CONFIG_CHANGED']}, ${JsonPrimitive(firstSid)})
            """.trimIndent())
            awaitDeviceRoundTrip(scenario)
            assertEquals("false", evaluate(scenario, "'prior-origin' in nativeReplies"))
            subscribe(scenario)
            scenario.onActivity { assertTrue(attachment.emit(CONFIG_CHANGED, JsonNull.INSTANCE)) }
            assertEvent(scenario, secondSid, JsonNull.INSTANCE)

            scenario.onActivity { loadPage(webView, "$UNLISTED_ORIGIN/unlisted") }
            awaitScript(scenario, "location.origin === '$UNLISTED_ORIGIN' && document.body?.id === 'probe'")
            assertEquals("true", evaluate(scenario, """
                typeof window.__OJSB_TRANSPORT__ === 'undefined' && typeof window.__ojsb_wml === 'undefined'
            """.trimIndent()))
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
                attachment = attachProbe(activity, config)
                testView = findWebView(activity)
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

    @Test
    @SuppressLint("SetJavaScriptEnabled")
    fun cancelNotificationReleasesTheOnlySlotInTheReleaseWebView() {
        val started = CompletableFuture<Unit>()
        val cancelled = CompletableFuture<Unit>()
        val config = BusinessMethod("acme.app.getConfig") {
            try {
                started.complete(Unit)
                awaitCancellation()
            } finally {
                if (!currentCoroutineContext().isActive) cancelled.complete(Unit)
            }
        }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var testView: WebView
            lateinit var attachment: AndroidBridge
            scenario.onActivity { activity ->
                attachment = attachProbe(activity, config, AndroidBridge.Options(deviceInfo = true))
                testView = findWebView(activity)
                loadPage(testView, "$ORIGIN/cancel")
            }
            try {
                hello(scenario, "/cancel")
                assertEquals("true", evaluate(scenario, """
                    nativeReplies['probe-hello'].result.capabilities.features.includes('cancel') &&
                      nativeReplies['probe-hello'].result.limits.maxInflight === 1
                """.trimIndent()))
                evaluate(scenario, "window.sendNative('held', 'acme.app.getConfig', {})")
                started.get(5, TimeUnit.SECONDS)
                evaluate(scenario, """
                    window.sendNative(undefined, 'bridge.cancel', {requestId: 'held', reason: 'abort'});
                    window.sendNative('next', 'device.getInfo', {});
                """.trimIndent())
                cancelled.get(5, TimeUnit.SECONDS)
                awaitScript(scenario, "!!nativeReplies.held && !!nativeReplies.next")
                assertEquals("-32002", evaluate(scenario, "nativeReplies.held.error.code"))
                assertEquals("\"android\"", evaluate(scenario, "nativeReplies.next.result.os"))
                assertEquals("true", evaluate(scenario, "nativeReplyIds.slice(1).sort().join() === 'held,next'"))
            } finally {
                scenario.onActivity {
                    attachment.detach()
                    (testView.parent as? ViewGroup)?.removeView(testView)
                    testView.destroy()
                }
            }
        }
    }

    private fun withEventProbe(
        events: List<String> = emptyList(),
        shouldForwardCommit: (String) -> Boolean = { true },
        allowedOrigins: List<String> = listOf(ORIGIN),
        run: (ActivityScenario<MainActivity>, WebView, AndroidBridge) -> Unit,
    ) {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var testView: WebView
            lateinit var attachment: AndroidBridge
            scenario.onActivity { activity ->
                assertFalse(activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
                attachment = attachProbe(
                    activity,
                    options = AndroidBridge.Options(deviceInfo = true),
                    events = events,
                    shouldForwardCommit = shouldForwardCommit,
                    allowedOrigins = allowedOrigins,
                )
                testView = findWebView(activity)
            }
            try {
                run(scenario, testView, attachment)
            } finally {
                scenario.onActivity {
                    attachment.detach()
                    (testView.parent as? ViewGroup)?.removeView(testView)
                    testView.destroy()
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun attachProbe(
        activity: MainActivity,
        config: BusinessMethod? = null,
        options: AndroidBridge.Options = AndroidBridge.Options(),
        events: List<String> = emptyList(),
        shouldForwardCommit: (String) -> Boolean = { true },
        allowedOrigins: List<String> = listOf(ORIGIN),
    ): AndroidBridge {
        lateinit var attachment: AndroidBridge
        val webView = WebView(activity).apply {
            id = R.id.demo_webview
            settings.javaScriptEnabled = true
            webViewClient = object : WebViewClient() {
                override fun onPageCommitVisible(view: WebView, url: String) {
                    if (shouldForwardCommit(url)) attachment.onPageCommitVisible(url)
                }
            }
        }
        attachment = checkNotNull(
            AndroidBridge.attach(webView, allowedOrigins, options, methods = listOfNotNull(config), events = events)
        )
        activity.setContentView(webView)
        return attachment
    }

    private fun hello(scenario: ActivityScenario<MainActivity>, path: String): String {
        startHello(scenario, path)
        return awaitHello(scenario)
    }

    private fun startHello(scenario: ActivityScenario<MainActivity>, path: String) {
        awaitScript(scenario, "location.pathname === '$path' && !!window.__OJSB_TRANSPORT__")
        evaluate(scenario, """
            window.nativeReplies = {};
            window.nativeReplyIds = [];
            window.nativeEvents = [];
            window.__OJSB_RECEIVE__ = raw => {
                const frame = JSON.parse(raw);
                const { rpc } = frame;
                if ('id' in rpc) {
                    nativeReplies[rpc.id] = rpc;
                    nativeReplyIds.push(rpc.id);
                } else {
                    nativeEvents.push(frame);
                }
            };
            window.sendNative = (id, method, params, sid = nativeReplies['probe-hello']?.result?.sid) => {
                const rpc = { jsonrpc: '2.0', id, method, params };
                window.__OJSB_TRANSPORT__.postMessage(JSON.stringify({ jsb: '1.0', rpc, meta: sid ? { sid } : undefined }));
            };
            window.sendNative('probe-hello', 'bridge.hello', { protocols: [1] });
        """.trimIndent())
    }

    private fun awaitHello(scenario: ActivityScenario<MainActivity>): String {
        awaitScript(scenario, "!!nativeReplies['probe-hello']?.result?.sid")
        return JsonParser.parseString(evaluate(scenario, "nativeReplies['probe-hello'].result.sid")).asString
    }

    private fun subscribe(scenario: ActivityScenario<MainActivity>, id: String = "subscribe") {
        evaluate(scenario, "window.sendNative('$id', 'bridge.subscribe@1', {events: ['$CONFIG_CHANGED']})")
        awaitScript(scenario, """
            nativeReplies['$id']?.result?.subscribed?.join() === '$CONFIG_CHANGED' &&
              nativeReplies['$id']?.result?.denied?.length === 0
        """.trimIndent())
    }

    private fun awaitDeviceRoundTrip(scenario: ActivityScenario<MainActivity>) {
        // The reply is ordered after any frame already posted to this document's channel.
        evaluate(scenario, "window.sendNative('probe-device', 'device.getInfo@1', {})")
        awaitScript(scenario, "nativeReplies['probe-device']?.result?.os === 'android'")
    }

    private fun assertEvent(scenario: ActivityScenario<MainActivity>, sid: String, payload: JsonElement) {
        awaitScript(scenario, "nativeEvents.length > 0")
        val events = JsonParser.parseString(evaluate(scenario, "nativeEvents")).asJsonArray
        assertEquals(1, events.size())
        val event = events[0].asJsonObject
        assertEquals("1.0", event["jsb"].asString)
        assertEquals(sid, event.getAsJsonObject("meta")["sid"].asString)
        val rpc = event.getAsJsonObject("rpc")
        assertEquals("2.0", rpc["jsonrpc"].asString)
        assertEquals("bridge.event", rpc["method"].asString)
        assertFalse(rpc.has("id"))
        val params = rpc.getAsJsonObject("params")
        assertEquals(CONFIG_CHANGED, params["name"].asString)
        assertEquals(payload, params["payload"])
    }

    private fun configPreferences() = InstrumentationRegistry.getInstrumentation().targetContext
        .getSharedPreferences("app-config", Context.MODE_PRIVATE)

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
        val status = evaluate(scenario, """
            [location.href, document.querySelector('#bridge-results')?.textContent, window.nativeReplies, window.nativeEvents]
        """.trimIndent())
        fail("Timed out while evaluating $script. WebView state was $status")
    }

    private companion object {
        const val ORIGIN = "https://app.example.test"
        const val SECOND_ORIGIN = "https://support.example.test"
        const val UNLISTED_ORIGIN = "https://unlisted.example.test"
        const val CONFIG_CHANGED = "acme.app.configChanged"
    }
}
