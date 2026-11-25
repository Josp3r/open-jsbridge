package dev.openjsbridge.host

import android.content.ComponentName
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
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
        if (pending != null) throw MediaFailure(-32008, "Rate limited")
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

        /** Use only the system single-image Photo Picker (API 33+); no file-provider fallback. */
        fun createIntent(context: Context): Intent? {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return null
            val intent = Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*")
            val activity = context.packageManager.resolveActivity(intent,
                PackageManager.MATCH_DEFAULT_ONLY or PackageManager.MATCH_SYSTEM_ONLY)?.activityInfo ?: return null
            return intent.setComponent(ComponentName(activity.packageName, activity.name))
        }

        private fun checkMainThread() {
            check(Looper.myLooper() === Looper.getMainLooper()) { "Use the WebView UI thread" }
        }
    }
}
