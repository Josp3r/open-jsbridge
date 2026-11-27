package dev.openjsbridge.host

import androidx.webkit.WebViewFeature
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for Android channel selection (`SEC-JSI-DEFAULT-001`):
 * the reference host requires both `WEB_MESSAGE_LISTENER` and `DOCUMENT_START_SCRIPT`
 * and never enables an `addJavascriptInterface` fallback channel.
 */
class AndroidBridgeChannelTest {
    @Test
    fun requiresBothWebMessageListenerAndDocumentStartScript() {
        val cases = listOf(
            Triple(false, false, false),
            Triple(false, true, false),
            Triple(true, false, false),
            Triple(true, true, true),
        )
        for ((hasWebMessageListener, hasDocumentStartScript, expected) in cases) {
            val supported = AndroidBridge.hasRequiredWebViewFeatures { feature ->
                when (feature) {
                    WebViewFeature.WEB_MESSAGE_LISTENER -> hasWebMessageListener
                    WebViewFeature.DOCUMENT_START_SCRIPT -> hasDocumentStartScript
                    else -> false
                }
            }
            assertEquals(
                "WEB_MESSAGE_LISTENER=$hasWebMessageListener, DOCUMENT_START_SCRIPT=$hasDocumentStartScript",
                expected,
                supported,
            )
        }
    }

    @Test
    fun bridgeOptionsDoNotExposeDegradedFallbackToggle() {
        val optionNames = AndroidBridge.Options::class.java.declaredFields.map { it.name }.toSet()
        assertFalse(optionNames.any { it.contains("fallback", ignoreCase = true) || it.contains("jsi", ignoreCase = true) })
        assertTrue(AndroidBridge.hasRequiredWebViewFeatures {
            it == WebViewFeature.WEB_MESSAGE_LISTENER || it == WebViewFeature.DOCUMENT_START_SCRIPT
        })
    }
}
