package dev.openjsbridge.sdkconsumer

import android.accessibilityservice.AccessibilityService
import android.content.ContentValues
import android.content.pm.ApplicationInfo
import android.icu.text.DateFormat
import android.icu.text.DisplayContext
import android.os.Build
import android.os.Environment
import android.os.SystemClock
import android.provider.MediaStore
import android.provider.MediaStore.MediaColumns
import android.util.Base64
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import dev.openjsbridge.host.AndroidMediaPicker
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.FileNotFoundException
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = Build.VERSION_CODES.TIRAMISU)
class ReleaseSystemPhotoPickerTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext
    private val automation get() = instrumentation.uiAutomation
    private val pickerPackage by lazy {
        val intent = checkNotNull(AndroidMediaPicker.createIntent(app)) {
            "Run the media tests on an Android 13+ device with the system Photo Picker (API 35 emulator recommended)"
        }
        assertEquals(MediaStore.ACTION_PICK_IMAGES, intent.action)
        val component = checkNotNull(intent.component)
        val flags = app.packageManager.getApplicationInfo(component.packageName, 0).flags
        assertTrue("Expected an external system Photo Picker: $component",
            component.packageName != app.packageName &&
                flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0,
        )
        component.packageName
    }

    @Test
    fun packagedWebSdkPicksReadsAndReleasesTheSharedPngInRelease() = withFixture { fixture ->
        inRelease { scenario ->
            val ref = selectFixture(scenario, fixture)
            assertReadable(scenario, ref, fixture)
            val release = call(scenario, "window.__sdkMediaRelease(${JSONObject.quote(ref)})")
            assertEquals(0, value(release).length())
            assertRejected(PERMISSION_DENIED, call(scenario, readExpression(ref)))
        }
    }

    @Test
    fun systemBackCancelsThePickerWithoutReturningABlob() = inRelease { scenario ->
        val outcome = withPicker(scenario, "window.__sdkMediaProbe()") {
            // Use the system Back action just as a user would; no injected Activity result.
            assertTrue("Could not dismiss the system Photo Picker", automation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK))
        }
        val result = value(outcome)
        assertEquals("cancelled", result.getString("status"))
        assertEquals("Cancellation must not expose a blob or any metadata", 1, result.length())
    }

    @Test
    fun navigationInvalidatesTheBlobAndDifferentPortCannotUseMedia() = withFixture { fixture ->
        inRelease { scenario ->
            val ref = selectFixture(scenario, fixture)
            // This ref is live and unreleased before the navigation.
            assertReadable(scenario, ref, fixture)

            replaceDocument(scenario, ConsumerActivity.ORIGIN, "/media-replacement")
            assertRejected(PERMISSION_DENIED, call(scenario, readExpression(ref)))

            val otherOrigin = ConsumerActivity.ORIGIN + ":444"
            replaceDocument(scenario, otherOrigin, "/media-denied")
            assertEquals("true", evaluate(scenario, """
                typeof window.__OJSB_TRANSPORT__ === 'undefined' && typeof window.__ojsb_wml === 'undefined'
            """.trimIndent()))
            // The *same packaged Web SDK code* runs on the other port, but cannot make a media call.
            assertRejected(UNAVAILABLE, call(scenario, readExpression(ref)))
            assertRejected(UNAVAILABLE, call(scenario, "window.__sdkMediaProbe()"))
        }
    }

    private fun selectFixture(scenario: ActivityScenario<ConsumerActivity>, fixture: Fixture): String {
        val outcome = withPicker(scenario, "window.__sdkMediaProbe(${JSONObject.quote(fixture.base64)})") {
            await("Photo Picker tile for ${fixture.displayName} (${fixture.timestamps.joinToString()})", PICKER_TIMEOUT) {
                val root = automation.rootInActiveWindow ?: return@await false
                if (root.packageName?.toString() != pickerPackage) return@await false
                val matches = descendants(root).filter { node ->
                    val description = node.contentDescription?.toString().orEmpty()
                    node.isVisibleToUser && node.isClickable &&
                        (description.contains(fixture.displayName) || fixture.timestamps.any { description.contains(it) })
                }.toList()
                assertTrue("Multiple picker tiles match the fixture; refusing to select an ambiguous photo", matches.size <= 1)
                matches.singleOrNull()?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
            }
        }
        val result = value(outcome)
        assertEquals("selected", result.getString("status"))
        assertEquals(PNG_MIME, result.getString("mime"))
        assertEquals(fixture.size, result.getInt("size"))
        assertEquals(fixture.base64, result.getString("bytesBase64"))
        assertEquals(setOf("status", "mime", "size", "bytesBase64", "blobRef"), result.keys().asSequence().toSet())
        val ref = result.getString("blobRef")
        assertTrue("Expected an opaque blob reference rather than a path or URI", ref.isNotBlank() && !ref.contains('/') && !ref.contains(':'))
        Log.i(TAG, "Shared PNG selected via $pickerPackage, ${fixture.size} bytes verified by the Web SDK")
        return ref
    }

    private fun assertReadable(scenario: ActivityScenario<ConsumerActivity>, ref: String, fixture: Fixture) {
        val read = value(call(scenario, readExpression(ref)))
        assertEquals(fixture.base64, read.getString("dataBase64"))
        assertTrue("The small fixture should fit in one read: $read", read.getBoolean("done"))
    }

    private fun readExpression(ref: String) = "window.__sdkMediaRead(${JSONObject.quote(ref)})"

    private fun withFixture(run: (Fixture) -> Unit) {
        val bytes = try {
            instrumentation.context.assets.open("MediaFixture.png").use { it.readBytes() }
        } catch (error: FileNotFoundException) {
            throw AssertionError("Build the shared SDK consumer or set -PojsbConsumerMediaFixture to its MediaFixture.png", error)
        }
        val displayName = "ojsb-release-${UUID.randomUUID()}.png"
        val resolver = app.contentResolver
        val row = checkNotNull(resolver.insert(
            MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
            ContentValues().apply {
                put(MediaColumns.DISPLAY_NAME, displayName)
                put(MediaColumns.MIME_TYPE, PNG_MIME)
                put(MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/OpenJSBridgeTest")
                // Keep the test tile ahead of older photos and give it a distinct picker label.
                put(MediaColumns.DATE_TAKEN, System.currentTimeMillis() + 60_000)
                put(MediaColumns.IS_PENDING, 1)
            },
        )) { "Could not insert the test-owned PNG into MediaStore" }
        try {
            checkNotNull(resolver.openOutputStream(row)).use { it.write(bytes) }
            assertEquals(1, resolver.update(row, ContentValues().apply { put(MediaColumns.IS_PENDING, 0) }, null, null))
            val columns = arrayOf(MediaColumns.DATE_TAKEN, MediaColumns.DATE_MODIFIED, MediaColumns.DATE_ADDED)
            val times = checkNotNull(resolver.query(row, columns, null, null, null)).use { cursor ->
                check(cursor.moveToFirst()) { "Published MediaStore row not found: $displayName" }
                // DATE_TAKEN is in milliseconds; the fallback file timestamps are in seconds.
                listOf(cursor.getLong(0), cursor.getLong(1) * 1000, cursor.getLong(2) * 1000).filter { it > 0 }
            }
            // AOSP's picker labels photos with their localized date and time, not the filename.
            val format = DateFormat.getInstanceForSkeleton("MMMdyhmmss", Locale.getDefault()).apply {
                setContext(DisplayContext.CAPITALIZATION_FOR_BEGINNING_OF_SENTENCE)
            }
            run(Fixture(displayName, times.map { format.format(Date(it)) }.toSet(), bytes.size,
                Base64.encodeToString(bytes, Base64.NO_WRAP)))
        } finally {
            // Delete only the URI returned by our own insert, even if selection or assertions fail.
            assertEquals("Could not clean up the test-owned MediaStore row", 1, resolver.delete(row, null, null))
        }
    }

    private fun inRelease(run: (ActivityScenario<ConsumerActivity>) -> Unit) {
        ActivityScenario.launch(ConsumerActivity::class.java).use { scenario ->
            scenario.onActivity {
                assertFalse("Must run against the Release APK", it.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
            }
            awaitScript(scenario, "location.origin === ${JSONObject.quote(ConsumerActivity.ORIGIN)} && $MEDIA_PROBES")
            run(scenario)
        }
    }

    private fun replaceDocument(scenario: ActivityScenario<ConsumerActivity>, origin: String, path: String) {
        val page = app.assets.open("ReleaseToast.html").bufferedReader(Charsets.UTF_8).use { it.readText() }
        scenario.onActivity { activity ->
            checkNotNull(activity.browser).loadDataWithBaseURL(origin + path, page, "text/html", "UTF-8", null)
        }
        awaitScript(scenario, "location.href === ${JSONObject.quote(origin + path)} && $MEDIA_PROBES")
    }

    private fun withPicker(scenario: ActivityScenario<ConsumerActivity>, expression: String, interact: () -> Unit): JSONObject {
        val expectedPackage = pickerPackage
        try {
            startCall(scenario, expression)
            await("system Photo Picker ($expectedPackage)", PICKER_TIMEOUT) { activePackage() == expectedPackage }
            interact()
            await("Release activity to return from the Photo Picker", PICKER_TIMEOUT) { activePackage() == app.packageName }
            return awaitCall(scenario)
        } finally {
            if (activePackage() == expectedPackage) automation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
        }
    }

    private fun activePackage() = automation.rootInActiveWindow?.packageName?.toString()

    private fun descendants(node: AccessibilityNodeInfo): Sequence<AccessibilityNodeInfo> = sequence {
        yield(node)
        for (index in 0 until node.childCount) {
            node.getChild(index)?.let { yieldAll(descendants(it)) }
        }
    }

    private fun call(scenario: ActivityScenario<ConsumerActivity>, expression: String): JSONObject {
        startCall(scenario, expression)
        return awaitCall(scenario)
    }

    private fun startCall(scenario: ActivityScenario<ConsumerActivity>, expression: String) {
        evaluate(scenario, """
            delete window.__androidMediaResult;
            void Promise.resolve().then(() => $expression).then(
              value => { window.__androidMediaResult = { ok: true, value }; },
              error => { window.__androidMediaResult = { ok: false, code: error?.code ?? null, message: String(error) }; }
            );
        """.trimIndent())
    }

    private fun awaitCall(scenario: ActivityScenario<ConsumerActivity>): JSONObject {
        awaitScript(scenario, "window.__androidMediaResult !== undefined")
        return JSONObject(evaluate(scenario, "window.__androidMediaResult"))
    }

    private fun value(outcome: JSONObject): JSONObject {
        assertTrue("Expected successful Web SDK result: $outcome", outcome.getBoolean("ok"))
        return outcome.getJSONObject("value")
    }

    private fun assertRejected(code: Int, outcome: JSONObject) {
        assertFalse("Expected Web SDK rejection: $outcome", outcome.getBoolean("ok"))
        assertEquals("Unexpected Web SDK error: $outcome", code, outcome.optInt("code"))
    }

    private fun evaluate(scenario: ActivityScenario<ConsumerActivity>, script: String): String {
        val result = CompletableFuture<String>()
        scenario.onActivity { activity -> checkNotNull(activity.browser).evaluateJavascript(script, result::complete) }
        return result.get(5, TimeUnit.SECONDS)
    }

    private fun awaitScript(scenario: ActivityScenario<ConsumerActivity>, predicate: String) {
        try {
            await(predicate) { evaluate(scenario, predicate) == "true" }
        } catch (error: AssertionError) {
            throw AssertionError("${error.message}. WebView: ${evaluate(scenario, "[location.href, window.__androidMediaResult]")}", error)
        }
    }

    private fun await(description: String, timeout: Long = 15_000, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + timeout
        do {
            if (condition()) return
            SystemClock.sleep(100)
        } while (SystemClock.elapsedRealtime() < deadline)
        throw AssertionError("Timed out waiting for $description. Active package: ${activePackage()}")
    }

    private data class Fixture(val displayName: String, val timestamps: Set<String>, val size: Int, val base64: String)

    private companion object {
        const val TAG = "OjsbSdkPhotoPickerTest"
        const val PNG_MIME = "image/png"
        const val PICKER_TIMEOUT = 10_000L
        const val PERMISSION_DENIED = -32003
        const val UNAVAILABLE = -32000
        const val MEDIA_PROBES = """typeof window.__sdkMediaProbe === 'function' &&
            typeof window.__sdkMediaRead === 'function' && typeof window.__sdkMediaRelease === 'function'"""
    }
}
