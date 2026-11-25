package dev.openjsbridge.host

import android.content.ComponentName
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia
import androidx.annotation.MainThread
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.File
import java.io.IOException
import kotlin.coroutines.resume

/**
 * Adapter for an app-owned Activity Result launcher. Use one picker per launcher;
 * register it before the Activity is started, and route every result to [onResult].
 * [launch] must launch [createIntent], not select a URI on behalf of the Web page.
 */
class AndroidMediaPicker(private val launch: () -> Unit) {
    private var pending: CancellableContinuation<Uri?>? = null

    /** Pass null when the system picker was dismissed; results after cancellation are ignored. */
    @MainThread
    fun onResult(uri: Uri?) {
        checkMainThread()
        val request = pending ?: return
        pending = null
        if (request.isActive) request.resume(uri)
    }

    private suspend fun pick(): Uri? = suspendCancellableCoroutine { request ->
        checkMainThread()
        // A cancelled RPC does not dismiss the system UI. Keep the launcher busy
        // until that Activity reports its result, even across document replacement.
        if (pending != null) throw MediaFailure(-32010, "Busy")
        if (!request.isActive) return@suspendCancellableCoroutine
        pending = request
        try {
            launch()
        } catch (error: RuntimeException) {
            if (pending === request) pending = null
            throw error
        }
    }

    internal fun module(context: Context): MediaModule {
        val app = context.applicationContext
        val resolver = app.contentResolver
        val main = Handler(Looper.getMainLooper())
        return MediaModule(
            pick = {
                pick()?.let { uri ->
                    if (uri.scheme != ContentResolver.SCHEME_CONTENT) throw IOException("Expected picker content")
                    MediaImage({ resolver.getType(uri) }) {
                        resolver.openInputStream(uri) ?: throw IOException("Cannot open picked image")
                    }
                }
            },
            directory = File(app.cacheDir, "open-jsbridge-media"),
            generateThumbnail = ::androidMediaThumbnail,
            scheduleExpiry = { delay, callback ->
                val expire = Runnable { callback() }
                main.postDelayed(expire, delay)
                ({ main.removeCallbacks(expire) })
            },
            elapsedMillis = SystemClock::elapsedRealtime,
        )
    }

    companion object {
        fun isAvailable(context: Context): Boolean = createIntent(context) != null

        /** Resolve the installed system or backported single-image Photo Picker. */
        fun createIntent(context: Context): Intent? {
            try {
                val intent = PickVisualMedia().createIntent(context, PickVisualMediaRequest(PickVisualMedia.ImageOnly))
                if (!isSystemPhotoPickerAction(intent.action)) return null
                val activity = context.packageManager.resolveActivity(intent,
                    PackageManager.MATCH_DEFAULT_ONLY or PackageManager.MATCH_SYSTEM_ONLY)?.activityInfo ?: return null
                val systemFlags = ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP
                if (!activity.enabled || !activity.exported || activity.applicationInfo.flags and systemFlags == 0) {
                    return null
                }
                return intent.setComponent(ComponentName(activity.packageName, activity.name))
            } catch (_: RuntimeException) {
                // Availability can change while AndroidX resolves the backport.
                return null
            }
        }

        private fun checkMainThread() {
            check(Looper.myLooper() === Looper.getMainLooper()) { "Use the WebView UI thread" }
        }
    }
}

// Activity 1.9.3 selects the Play services module via this package-manager action.
private const val GMS_PHOTO_PICKER_ACTION = "com.google.android.gms.provider.action.PICK_IMAGES"

internal fun isSystemPhotoPickerAction(action: String?): Boolean =
    action == MediaStore.ACTION_PICK_IMAGES ||
        action == PickVisualMedia.ACTION_SYSTEM_FALLBACK_PICK_IMAGES ||
        action == GMS_PHOTO_PICKER_ACTION
