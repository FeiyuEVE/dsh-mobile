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

/** Whether a failed trusted-session renewal is worth retrying without user input. */
internal enum class RestoreFailureDisposition {
    RETRY_TRANSIENT,
    REQUIRE_USER_ACTION,
}

/** Selects valid cold-start restore targets without depending on Android lifecycle state. */
internal object ConnectionRestorePolicy {
    /**
     * Whether a persisted device credential may renew its short session instead of
     * pairing again. Applies to both LAN and REMOTE transports: once a device is
     * paired, its deviceToken stays valid across gateway restarts (the digest is
     * persisted in the plugin's devices.json), so renewing beats re-pairing.
     */
    fun shouldRenewBeforePairing(
        mode: AccessMode,
        credential: DeviceCredential?,
        instanceId: String,
        now: Long,
    ): Boolean = credential != null && credential.expiresAt > now
        && credential.instanceId == instanceId

    fun mayPairAfterRenewFailure(failure: Throwable): Boolean =
        (failure as? NativeAuthFailure)?.kind == NativeAuthFailureKind.PAIRING_EXPIRED

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

    fun failureDisposition(
        failure: Throwable?,
        instanceMismatch: Boolean,
    ): RestoreFailureDisposition {
        if (instanceMismatch) return RestoreFailureDisposition.REQUIRE_USER_ACTION
        return when ((failure as? NativeAuthFailure)?.kind) {
            NativeAuthFailureKind.TIMEOUT,
            NativeAuthFailureKind.NETWORK,
            NativeAuthFailureKind.SERVER_UNAVAILABLE,
            -> RestoreFailureDisposition.RETRY_TRANSIENT
            else -> RestoreFailureDisposition.REQUIRE_USER_ACTION
        }
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
