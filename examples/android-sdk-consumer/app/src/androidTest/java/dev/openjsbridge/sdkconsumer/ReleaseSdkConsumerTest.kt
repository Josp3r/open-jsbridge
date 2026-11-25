package dev.openjsbridge.sdkconsumer

import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

@RunWith(AndroidJUnit4::class)
class ReleaseSdkConsumerTest {
    @Test
    fun packagedWebSdkShowsTheNativeToastInRelease() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val targetPackage = instrumentation.targetContext.packageName
        val automation = instrumentation.uiAutomation
        ActivityScenario.launch(ConsumerActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                assertFalse("Must run against the Release APK", activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
            }
            await(scenario, "typeof window.__sdkToastProbe === 'function'")
            assertEquals(ConsumerActivity.ORIGIN, JSONTokener(evaluate(scenario, "location.origin")).nextValue())

            // Observe Android's Toast presentation, not a Web DOM update or a fake native handler.
            val toast = try {
                automation.executeAndWaitForEvent({
                    evaluate(scenario, """
                        void Promise.resolve().then(() => window.__sdkToastProbe()).then(
                          result => { window.__androidConsumerResult = { result }; },
                          error => { window.__androidConsumerResult = { error: String(error) }; }
                        )
                    """.trimIndent())
                }, { event ->
                    event.eventType == AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED &&
                        event.className?.toString() == "android.widget.Toast" &&
                        event.packageName?.toString() in setOf(targetPackage, "com.android.systemui") &&
                        event.text.any { it.toString() == TOAST_TEXT }
                }, 8_000)
            } catch (error: TimeoutException) {
                throw AssertionError("No matching native Toast event. WebView: ${evaluate(scenario, STATE)}", error)
            }
            try {
                Log.i(TAG, "Native Toast: package=${toast.packageName} class=${toast.className} text=${toast.text}")
                // SystemUI emits the event as the Toast is attached, before its enter animation.
                // Give it time to draw before taking the optional visual evidence.
                runCatching {
                    SystemClock.sleep(250)
                    val screenshot = checkNotNull(automation.takeScreenshot())
                    try {
                        val file = File(checkNotNull(instrumentation.targetContext.getExternalFilesDir(null)), "native-toast.png")
                        file.outputStream().use { check(screenshot.compress(Bitmap.CompressFormat.PNG, 100, it)) }
                        Log.i(TAG, "Toast screenshot: ${file.absolutePath}")
                    } finally {
                        screenshot.recycle()
                    }
                }.onFailure { Log.w(TAG, "Could not retain Toast screenshot", it) }
            } finally {
                @Suppress("DEPRECATION")
                toast.recycle()
            }

            await(scenario, "window.__androidConsumerResult !== undefined")
            val state = JSONObject(evaluate(scenario, STATE))
            val outcome = state.getJSONObject("outcome")
            assertFalse(state.toString(), outcome.has("error"))
            val result = outcome.getJSONObject("result")
            assertEquals("passed", result.getString("status"))
            assertEquals("android", result.getString("os"))
            assertEquals(TOAST_TEXT, result.getString("text"))
            assertEquals("passed", state.getString("probe"))
            assertEquals("Toast accepted by android", state.getString("statusText"))
            Log.i(TAG, "Web probe: $state")
        }
    }

    @Test
    fun navigationToAnotherPortDoesNotGetTheNativeTransport() {
        ActivityScenario.launch(ConsumerActivity::class.java).use { scenario ->
            await(scenario, "typeof window.__sdkToastProbe === 'function'")
            val wrongOrigin = ConsumerActivity.ORIGIN + ":444"
            scenario.onActivity { activity ->
                checkNotNull(activity.browser).loadDataWithBaseURL(
                    "$wrongOrigin/other", "<!doctype html><body id='other-origin'>", "text/html", "UTF-8", null,
                )
            }
            await(scenario, "document.body?.id === 'other-origin'")
            assertEquals(wrongOrigin, JSONTokener(evaluate(scenario, "location.origin")).nextValue())
            assertEquals("true", evaluate(scenario, """
                typeof window.__OJSB_TRANSPORT__ === 'undefined' &&
                  typeof window.__ojsb_wml === 'undefined'
            """.trimIndent()))
        }
    }

    private fun await(scenario: ActivityScenario<ConsumerActivity>, predicate: String) {
        val deadline = SystemClock.elapsedRealtime() + 15_000
        do {
            if (evaluate(scenario, predicate) == "true") return
            SystemClock.sleep(100)
        } while (SystemClock.elapsedRealtime() < deadline)
        throw AssertionError("Timed out waiting for $predicate. WebView: ${evaluate(scenario, STATE)}")
    }

    private fun evaluate(scenario: ActivityScenario<ConsumerActivity>, script: String): String {
        val result = CompletableFuture<String>()
        scenario.onActivity { activity -> checkNotNull(activity.browser).evaluateJavascript(script, result::complete) }
        return result.get(5, TimeUnit.SECONDS)
    }

    private companion object {
        const val TAG = "OjsbSdkConsumerTest"
        const val TOAST_TEXT = "Open JSBridge native toast"
        const val STATE = """({origin: location.origin, outcome: window.__androidConsumerResult,
            probe: document.documentElement.dataset.probe, statusText: document.querySelector('#status')?.textContent})"""
    }
}
