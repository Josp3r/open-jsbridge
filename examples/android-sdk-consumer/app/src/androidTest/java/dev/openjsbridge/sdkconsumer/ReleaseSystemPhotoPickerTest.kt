package dev.openjsbridge.sdkconsumer

import android.accessibilityservice.AccessibilityService
import android.content.ContentValues
import android.content.pm.ApplicationInfo
import android.graphics.BitmapFactory
import android.icu.text.DateFormat
import android.icu.text.DisplayContext
import android.os.Build
import android.os.Environment
import android.os.SystemClock
import android.provider.MediaStore
import android.provider.MediaStore.MediaColumns
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import dev.openjsbridge.host.AndroidMediaPicker
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeNotNull
import org.junit.Test
import org.junit.runner.RunWith
import java.io.FileNotFoundException
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
// The fixture inserts a scoped MediaStore row, which requires Android 10+.
@SdkSuppress(minSdkVersion = Build.VERSION_CODES.Q)
class ReleaseSystemPhotoPickerTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext
    private val automation get() = instrumentation.uiAutomation
    private val pickerPackage by lazy {
        val candidate = AndroidMediaPicker.createIntent(app)
        assumeNotNull(candidate)
        val intent = checkNotNull(candidate)
        assertTrue(intent.action in setOf(
            MediaStore.ACTION_PICK_IMAGES,
            PickVisualMedia.ACTION_SYSTEM_FALLBACK_PICK_IMAGES,
            "com.google.android.gms.provider.action.PICK_IMAGES",
        ))
        val component = checkNotNull(intent.component)
        val flags = app.packageManager.getApplicationInfo(component.packageName, 0).flags
        assertTrue("Expected an external system Photo Picker: $component",
            component.packageName != app.packageName &&
                flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0,
        )
        component.packageName
    }

    @Test
    fun packagedWebSdkRendersABoundedJpegThumbnailInRelease() = withFixture { fixture ->
        inRelease { scenario ->
            val thumbUrl = selectFixture(scenario, fixture)
            assertTrue("New thumbnail URL must be readable", isThumbnailReadable(scenario, thumbUrl))
            val jpeg = value(call(scenario, """
                (async () => {
                  const response = await fetch(${JSONObject.quote(thumbUrl)});
                  if (!response.ok) throw new Error('Thumbnail fetch failed: ' + response.status);
                  const image = await response.blob();
                  const signature = new Uint8Array(await image.slice(0, 2).arrayBuffer());
                  return { mime: image.type, size: image.size, jpeg: signature[0] === 255 && signature[1] === 216 };
                })()
            """.trimIndent()))
            assertEquals("image/jpeg", jpeg.getString("mime"))
            assertTrue("Blob URL must point to an actual JPEG", jpeg.getBoolean("jpeg"))
            assertTrue("Expected a JPEG within the 32 KiB decoded limit: $jpeg", jpeg.getInt("size") in 1..MAX_THUMBNAIL_BYTES)
            Log.i(TAG, "JPEG fetched from preview Blob URL: ${jpeg.getInt("size")} bytes")
        }
    }

    @Test
    fun systemBackCancelsThePickerWithoutReturningAThumbnail() = inRelease { scenario ->
        val outcome = withPicker(scenario, "window.__sdkMediaProbe()") {
            // Use the system Back action just as a user would; no injected Activity result.
            assertTrue("Could not dismiss the system Photo Picker", automation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK))
        }
        val result = value(outcome)
        assertEquals("cancelled", result.getString("status"))
        assertEquals("Cancellation must not expose a URL or any metadata", 1, result.length())
    }

    @Test
    fun sameOriginReplacementCannotFetchThePreviousDocumentsThumbnail() = withFixture { fixture ->
        inRelease { scenario ->
            val thumbUrl = selectFixture(scenario, fixture)
            assertTrue("Confirm the old URL works before navigating", isThumbnailReadable(scenario, thumbUrl))

            replaceDocument(scenario, ConsumerActivity.ORIGIN, "/media-replacement")
            assertEquals("true", evaluate(scenario, "typeof window.__androidMediaResult === 'undefined'"))
            assertFalse("A fresh same-origin document must not read the old URL", isThumbnailReadable(scenario, thumbUrl))
            // Also try fetch directly; the page helper alone could reject a URL it did not create.
            val fetch = value(call(scenario, """
                fetch(${JSONObject.quote(thumbUrl)}).then(response => ({ readable: response.ok }), () => ({ readable: false }))
            """.trimIndent()))
            assertFalse("The previous document's Blob URL must no longer resolve", fetch.getBoolean("readable"))
        }
    }

    @Test
    fun unlistedPortCannotUseThePackagedMediaProbe() = inRelease { scenario ->
        replaceDocument(scenario, ConsumerActivity.ORIGIN + ":444", "/media-denied")
        assertEquals("true", evaluate(scenario, """
            typeof window.__OJSB_TRANSPORT__ === 'undefined' && typeof window.__ojsb_wml === 'undefined'
        """.trimIndent()))
        // The same packaged npm page runs on the other port, but cannot open the native picker.
        assertRejected(UNAVAILABLE, call(scenario, "window.__sdkMediaProbe()"))
    }

    @Test
    fun nativeHandshakeAndDispatchDoNotExposeLegacyBlobMethods() = inRelease { scenario ->
        // A separate test document exercises the real injected transport without sharing the
        // npm page's receiver or letting SDK capability checks reject the requests locally.
        val url = ConsumerActivity.ORIGIN + "/thumbnail-wire-check"
        scenario.onActivity { activity ->
            checkNotNull(activity.browser).loadDataWithBaseURL(
                url, "<!doctype html><title>Thumbnail wire check</title>", "text/html", "UTF-8", null,
            )
        }
        awaitScript(scenario, "location.href === ${JSONObject.quote(url)} && !!window.__OJSB_TRANSPORT__")
        val wire = value(call(scenario, """
            (async () => {
              const transport = window.__OJSB_TRANSPORT__;
              const send = (id, method, params, sid) => new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('No native reply for ' + method)), 4000);
                window.__OJSB_RECEIVE__ = raw => {
                  const reply = JSON.parse(raw);
                  if (reply.rpc?.id !== id) return;
                  clearTimeout(timer);
                  resolve(reply.rpc);
                };
                transport.postMessage(JSON.stringify({
                  jsb: '1.0', rpc: { jsonrpc: '2.0', id, method, params },
                  ...(sid ? { meta: { sid } } : {})
                }));
              });
              try {
                const hello = await send('thumbnail-hello', 'bridge.hello', { protocols: [1] });
                if (!hello.result?.sid) throw new Error('No native session: ' + JSON.stringify(hello));
                const { sid, capabilities } = hello.result;
                const blobRef = '0'.repeat(32);
                const read = await send('thumbnail-old-read', 'bridge.blob.read@1', { blobRef, index: 0 }, sid);
                const release = await send('thumbnail-old-release', 'bridge.blob.release@1', { blobRef }, sid);
                return { capabilities, read, release };
              } finally {
                window.__OJSB_RECEIVE__ = undefined;
              }
            })()
        """.trimIndent()))
        val capabilities = wire.getJSONObject("capabilities")
        val methods = capabilities.getJSONObject("methods")
        assertEquals(1, methods.getJSONObject("media.chooseMedia").getJSONArray("versions").getInt(0))
        assertEquals(1, methods.getJSONObject("ui.toast.show").getJSONArray("versions").getInt(0))
        assertFalse("Legacy read must be absent from hello", methods.has("bridge.blob.read"))
        assertFalse("Legacy release must be absent from hello", methods.has("bridge.blob.release"))
        val features = capabilities.optJSONArray("features")
        if (features != null) {
            assertFalse("The blob feature must be absent from hello", (0 until features.length()).any { features.getString(it) == "blob" })
        }
        for (method in listOf("read", "release")) {
            val reply = wire.getJSONObject(method)
            assertEquals("Expected a native Method not found reply for legacy $method: $reply",
                METHOD_NOT_FOUND, reply.getJSONObject("error").getInt("code"))
        }
    }

    private fun selectFixture(scenario: ActivityScenario<ConsumerActivity>, fixture: Fixture): String {
        val outcome = withPicker(scenario, "window.__sdkMediaProbe()") {
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
        val fields = result.keys().asSequence().toSet()
        val required = setOf("status", "id", "mime", "size", "width", "height", "thumbnailWidth", "thumbnailHeight", "thumbUrl")
        assertTrue("Missing preview metadata: ${required - fields}", fields.containsAll(required))
        val unexpected = fields - required - setOf("type", "expiresAt")
        assertTrue("The probe must only return preview metadata, not original bytes, Base64 or URI fields: $unexpected", unexpected.isEmpty())
        assertEquals("selected", result.getString("status"))
        if (result.has("type")) assertEquals("image", result.getString("type"))
        if (result.has("expiresAt")) assertTrue("Image expiry must be in the future", result.getLong("expiresAt") > System.currentTimeMillis())
        assertTrue("Expected an opaque 32-hex image ID", IMAGE_ID.matches(result.getString("id")))
        assertEquals(PNG_MIME, result.getString("mime"))
        assertEquals(fixture.size, result.get("size"))
        assertEquals(FIXTURE_WIDTH, result.get("width"))
        assertEquals(FIXTURE_HEIGHT, result.get("height"))
        val width = result.getInt("thumbnailWidth")
        val height = result.getInt("thumbnailHeight")
        assertTrue("Thumbnail dimensions must each be in 1..256: ${width}x$height",
            width in 1..MAX_THUMBNAIL_EDGE && height in 1..MAX_THUMBNAIL_EDGE)
        val thumbUrl = result.getString("thumbUrl")
        assertTrue("Expected a browser Blob URL, not an original image URL or data URL", thumbUrl.startsWith("blob:"))
        awaitScript(scenario, """
            (() => {
              const preview = document.getElementById('media-preview');
              const status = document.getElementById('media-status');
              return status?.textContent?.trim() === 'Preview ready' && !!preview && !preview.hidden &&
                preview.complete && preview.currentSrc === ${JSONObject.quote(thumbUrl)} &&
                preview.naturalWidth === $width && preview.naturalHeight === $height;
            })()
        """.trimIndent())
        Log.i(TAG, "Photo Picker ($pickerPackage): ${FIXTURE_WIDTH}x$FIXTURE_HEIGHT PNG (${fixture.size} bytes) -> ${width}x$height preview")
        return thumbUrl
    }

    private fun isThumbnailReadable(scenario: ActivityScenario<ConsumerActivity>, thumbUrl: String): Boolean =
        value(call(scenario, """
            (async () => ({ readable: await window.__sdkThumbReadable(${JSONObject.quote(thumbUrl)}) }))()
        """.trimIndent())).getBoolean("readable")

    private fun withFixture(run: (Fixture) -> Unit) {
        val bytes = try {
            instrumentation.context.assets.open("MediaFixture.png").use { it.readBytes() }
        } catch (error: FileNotFoundException) {
            throw AssertionError("Build the shared SDK consumer or set -PojsbConsumerMediaFixture to its MediaFixture.png", error)
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        assertEquals("Expected the synthetic PNG from the thumbnail build", PNG_MIME, bounds.outMimeType)
        assertEquals("Expected the new 800×640 shared fixture", FIXTURE_WIDTH, bounds.outWidth)
        assertEquals("Expected the new 800×640 shared fixture", FIXTURE_HEIGHT, bounds.outHeight)
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
            run(Fixture(displayName, times.map { format.format(Date(it)) }.toSet(), bytes.size))
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

    private data class Fixture(val displayName: String, val timestamps: Set<String>, val size: Int)

    private companion object {
        const val TAG = "OjsbSdkPhotoPickerTest"
        const val PNG_MIME = "image/png"
        const val FIXTURE_WIDTH = 800
        const val FIXTURE_HEIGHT = 640
        const val MAX_THUMBNAIL_EDGE = 256
        const val MAX_THUMBNAIL_BYTES = 32 * 1024
        const val PICKER_TIMEOUT = 10_000L
        const val UNAVAILABLE = -32000
        const val METHOD_NOT_FOUND = -32601
        val IMAGE_ID = Regex("[0-9a-f]{32}")
        const val MEDIA_PROBES = """typeof window.__sdkMediaProbe === 'function' &&
            typeof window.__sdkThumbReadable === 'function'"""
    }
}
