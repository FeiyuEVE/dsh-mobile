package io.github.sayach.dshmobile

import java.util.Locale

/** Classifies the supported remote tunnel hosts without treating LAN origins as remote. */
internal object RemoteHostPolicy {
    private val supportedSuffixes = listOf(
        ".ts.net",
        ".cpolar.cn",
        ".cpolar.io",
        ".cpolar.top",
        ".cpolar.com",
    )

    /** Returns whether the host belongs to a supported remote tunnel provider. */
    fun isSupported(host: String): Boolean {
        val normalized = host.lowercase(Locale.ROOT)
        return supportedSuffixes.any(normalized::endsWith)
    }

    /** Returns whether this origin is valid for the selected connection mode. */
    fun isAllowed(mode: AccessMode, host: String): Boolean = when (mode) {
        AccessMode.LAN -> !isSupported(host)
        AccessMode.REMOTE -> isSupported(host)
    }

    /** Returns whether the host uses Tailscale and needs the mainland-China connectivity notice. */
    fun needsTailscaleVpnNotice(host: String): Boolean =
        host.lowercase(Locale.ROOT).endsWith(".ts.net")
}
