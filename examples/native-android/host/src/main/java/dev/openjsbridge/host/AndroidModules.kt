package dev.openjsbridge.host

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.Looper

internal fun androidDeviceModule(): DeviceModule = DeviceModule(
    Build.VERSION.RELEASE?.takeIf { it.isNotBlank() } ?: Build.VERSION.SDK_INT.toString(),
)

internal class AndroidNetwork(context: Context) : NetworkModule {
    private val app = context.applicationContext
    private val connectivity = app.getSystemService(ConnectivityManager::class.java)
    private val main = Handler(Looper.getMainLooper())

    val events: NetworkEvents?
        get() = if (connectivity != null &&
            app.checkSelfPermission(Manifest.permission.ACCESS_NETWORK_STATE) == PackageManager.PERMISSION_GRANTED
        ) NetworkEvents(::observe) else null

    override fun status(): NetworkType {
        val manager = connectivity ?: return NetworkType.UNKNOWN
        return try {
            val network = manager.activeNetwork ?: return NetworkType.NONE
            val capabilities = manager.getNetworkCapabilities(network) ?: return NetworkType.UNKNOWN
            namedTransports.entries.singleOrNull { capabilities.hasTransport(it.key) }?.value ?: NetworkType.OTHER
        } catch (_: SecurityException) {
            NetworkType.UNKNOWN
        }
    }

    private fun observe(onChange: (NetworkType) -> Unit): (() -> Unit)? {
        val manager = connectivity ?: return null
        var previous = status()
        var active = true
        val update = Runnable {
            if (!active) return@Runnable
            val current = status()
            if (current != previous) {
                previous = current
                onChange(current)
            }
        }
        // Connectivity callbacks arrive off the WebView thread. Re-read the latest
        // snapshot on the UI thread so network callbacks and RPCs use one mapping.
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { main.post(update) }
            override fun onLost(network: Network) { main.post(update) }
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) { main.post(update) }
            override fun onBlockedStatusChanged(network: Network, blocked: Boolean) { main.post(update) }
        }
        try {
            manager.registerDefaultNetworkCallback(callback)
        } catch (_: RuntimeException) {
            return null
        }
        main.post(update)
        return {
            active = false
            main.removeCallbacks(update)
            manager.unregisterNetworkCallback(callback)
        }
    }

    private companion object {
        val namedTransports = mapOf(
            NetworkCapabilities.TRANSPORT_WIFI to NetworkType.WIFI,
            NetworkCapabilities.TRANSPORT_CELLULAR to NetworkType.CELLULAR,
            NetworkCapabilities.TRANSPORT_ETHERNET to NetworkType.ETHERNET,
        )
    }
}
