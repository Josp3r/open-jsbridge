package dev.openjsbridge.host

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.webkit.WebView
import androidx.exifinterface.media.ExifInterface
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.io.File

/**
 * Verifies Android Photo Picker discovery, capability advertisement, and thumbnail decoding
 * across Android 10–12 (API 29–32, e.g. API 30 emulator) and Android 13+ (API 33+) runtimes (D-005 / D-014).
 */
@RunWith(AndroidJUnit4::class)
class AndroidPhotoPickerCompatTest {
    @get:Rule
    val temporary = TemporaryFolder(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir)

    @Test
    @Suppress("DEPRECATION")
    fun photoPickerAvailabilityMatchesResolvedSystemIntent() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = AndroidMediaPicker.createIntent(context)
        val available = AndroidMediaPicker.isAvailable(context)
        assertEquals(intent != null, available)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            assertTrue("Android 13+ must expose the system Photo Picker", available)
            assertNotNull(intent)
        }

        if (intent != null) {
            assertNotEquals(Intent.ACTION_OPEN_DOCUMENT, intent.action)
            assertTrue("Expected system or backported Photo Picker action, got ${intent.action}",
                isSystemPhotoPickerAction(intent.action))
            assertNotNull("Resolved Photo Picker intent must bind an explicit system component", intent.component)

            val resolved = context.packageManager.resolveActivity(
                intent,
                PackageManager.MATCH_DEFAULT_ONLY or PackageManager.MATCH_SYSTEM_ONLY,
            )?.activityInfo
            assertNotNull(resolved)
            val systemFlags = ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP
            assertTrue(resolved!!.enabled)
            assertTrue(resolved.exported)
            assertTrue((resolved.applicationInfo.flags and systemFlags) != 0)
        } else {
            assertTrue(
                "Photo Picker may only be absent below Android 13 (SDK=${Build.VERSION.SDK_INT})",
                Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU,
            )
            assertFalse(available)
        }
    }

    @Test
    fun handshakeMediaCapabilitiesFollowPhotoPickerAvailability() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val available = AndroidMediaPicker.isAvailable(context)

        lateinit var modules: BridgeModules
        instrumentation.runOnMainSync {
            val webView = WebView(context)
            try {
                modules = AndroidBridge.modulesFor(
                    webView,
                    AndroidBridge.Options(deviceInfo = true, media = true),
                    mediaPicker = AndroidMediaPicker {},
                )
            } finally {
                webView.destroy()
            }
        }

        if (available) {
            assertNotNull("Expected MediaModule when Photo Picker is available", modules.media)
        } else {
            assertNull("Expected MediaModule to stay disabled when Photo Picker is absent", modules.media)
        }

        val session = RpcSession(
            enableEcho = false,
            modules = modules,
            supportsCancellation = true,
        )
        try {
            val helloRaw = session.receive(
                """{"jsb":"1.0","rpc":{"jsonrpc":"2.0","id":"h-compat","method":"bridge.hello","params":{"protocols":[1]}}}""",
            )
            assertNotNull(helloRaw)
            val hello = JsonParser.parseString(helloRaw).asJsonObject
            val result = hello.getAsJsonObject("rpc").getAsJsonObject("result")
            val sid = result.get("sid").asString
            val methods = result.getAsJsonObject("capabilities").getAsJsonObject("methods")

            assertTrue(methods.has("device.getInfo"))
            assertEquals(available, methods.has("media.chooseMedia"))
            assertEquals(available, methods.has("media.release"))

            if (!available) {
                val chooseRaw = session.receive(
                    """{"jsb":"1.0","meta":{"sid":"$sid"},"rpc":{"jsonrpc":"2.0","id":"c-1","method":"media.chooseMedia","params":{"count":1}}}""",
                )
                assertNotNull(chooseRaw)
                val choose = JsonParser.parseString(chooseRaw).asJsonObject
                val error = choose.getAsJsonObject("rpc").getAsJsonObject("error")
                assertEquals(-32601, error.get("code").asInt)
            }
        } finally {
            session.close()
        }
    }

    @Test
    fun thumbnailGenerationAppliesExifOrientationWithinBounds() {
        val source: File = temporary.newFile("compat-thumb.jpg")
        val bitmap = Bitmap.createBitmap(120, 80, Bitmap.Config.ARGB_8888)
        try {
            bitmap.eraseColor(Color.BLUE)
            source.outputStream().use { out ->
                assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out))
            }
        } finally {
            bitmap.recycle()
        }
        ExifInterface(source).apply {
            setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_ROTATE_90.toString())
            saveAttributes()
        }

        val thumbnail = androidMediaThumbnail(source)
        assertEquals(80, thumbnail.width)
        assertEquals(120, thumbnail.height)
        assertTrue(thumbnail.jpeg.size in 4..MediaThumbnail.MAX_BYTES)
        assertEquals(0xFF.toByte(), thumbnail.jpeg[0])
        assertEquals(0xD8.toByte(), thumbnail.jpeg[1])
        assertEquals(0xFF.toByte(), thumbnail.jpeg[thumbnail.jpeg.size - 2])
        assertEquals(0xD9.toByte(), thumbnail.jpeg[thumbnail.jpeg.size - 1])
    }
}
