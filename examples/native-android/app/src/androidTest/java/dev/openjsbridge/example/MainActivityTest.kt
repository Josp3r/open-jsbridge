package dev.openjsbridge.example

import android.os.SystemClock
import android.webkit.WebView
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

    private fun echo(scenario: ActivityScenario<MainActivity>, text: String) {
        evaluate(scenario, """
            document.querySelector('#message').value = '$text';
            document.querySelector('#send').click();
        """.trimIndent())
        awaitScript(scenario, """
            document.querySelector('#connection-status')?.dataset.platform === 'android' &&
              document.querySelector('#result')?.textContent.includes('$text')
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
