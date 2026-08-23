package io.github.sayach.dshmobile

/** The gateway transport selected by the user for the most recent successful connection. */
internal enum class AccessMode {
    LAN,
    REMOTE,
    ;

    companion object {
        fun parse(value: String?): AccessMode? = entries.firstOrNull { it.name == value }
    }
}

/** A persisted connection that can renew its device session without pairing again. */
internal data class ConnectionRestoreTarget(
    val mode: AccessMode,
    val origin: GatewayOrigin,
    val credential: DeviceCredential,
)

/** Selects valid cold-start restore targets without depending on Android lifecycle state. */
internal object ConnectionRestorePolicy {
    fun targets(
        preferredMode: AccessMode?,
        lanOrigin: String?,
        lanCredential: DeviceCredential?,
        remoteOrigin: String?,
        remoteCredential: DeviceCredential?,
        now: Long,
    ): List<ConnectionRestoreTarget> {
        val available = buildMap {
            target(AccessMode.LAN, lanOrigin, lanCredential, now)?.let { put(AccessMode.LAN, it) }
            target(AccessMode.REMOTE, remoteOrigin, remoteCredential, now)?.let { put(AccessMode.REMOTE, it) }
        }
        val order = preferredMode?.let { listOf(it, it.other()) }
            ?: listOf(AccessMode.REMOTE, AccessMode.LAN)
        return order.mapNotNull(available::get)
    }

    private fun target(
        mode: AccessMode,
        rawOrigin: String?,
        credential: DeviceCredential?,
        now: Long,
    ): ConnectionRestoreTarget? {
        if (credential == null || credential.expiresAt <= now) return null
        val origin = GatewayOrigin.parse(rawOrigin.orEmpty()) ?: return null
        return ConnectionRestoreTarget(mode, origin, credential)
    }

    private fun AccessMode.other(): AccessMode = when (this) {
        AccessMode.LAN -> AccessMode.REMOTE
        AccessMode.REMOTE -> AccessMode.LAN
    }
}
