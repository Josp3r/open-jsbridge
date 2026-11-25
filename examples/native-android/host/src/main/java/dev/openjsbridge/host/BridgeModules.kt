package dev.openjsbridge.host

import com.google.gson.JsonObject

internal data class BridgeModules(
    val device: DeviceModule? = null,
    val network: NetworkModule? = null,
    val networkEvents: NetworkEvents? = null,
    val toast: ToastModule? = null,
    val media: MediaModule? = null,
    val appLifecycle: AppLifecycleEvents? = null,
)

internal class DeviceModule(private val osVersion: String) {
    init {
        require(osVersion.isNotBlank())
    }

    fun info() = JsonObject().apply {
        addProperty("os", "android")
        addProperty("osVersion", osVersion)
    }
}

internal fun interface NetworkModule {
    fun status(): NetworkType
}

internal fun interface NetworkEvents {
    /** Observe changes on the WebView thread. Return cleanup, or null if observation is unavailable. */
    fun observe(onChange: (NetworkType) -> Unit): (() -> Unit)?
}

internal fun interface AppLifecycleEvents {
    /** Observe process transitions on the WebView thread and return cleanup. */
    fun observe(onTransition: (AppLifecycleEvent) -> Unit): () -> Unit
}

internal enum class AppLifecycleEvent(val wireName: String) {
    FOREGROUNDED("app.foregrounded"),
    BACKGROUNDED("app.backgrounded"),
}

internal fun interface ToastModule {
    fun show(text: String)
}

internal enum class NetworkType(val wireName: String) {
    WIFI("wifi"),
    CELLULAR("cellular"),
    ETHERNET("ethernet"),
    OTHER("other"),
    NONE("none"),
    UNKNOWN("unknown");

    fun snapshot() = JsonObject().apply { addProperty("type", wireName) }
}
