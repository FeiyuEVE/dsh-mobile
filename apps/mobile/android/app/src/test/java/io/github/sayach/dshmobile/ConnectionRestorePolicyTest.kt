package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Verifies cold-start ordering and persistence migration for LAN and remote connections. */
class ConnectionRestorePolicyTest {
    private val now = 1_000L
    private val lanCredential = credential("a", now + 10_000)
    private val remoteCredential = credential("b", now + 10_000)

    @Test
    fun restoresTheLastSuccessfulRemoteConnectionFirst() {
        val targets = targets(AccessMode.REMOTE)

        assertEquals(listOf(AccessMode.REMOTE, AccessMode.LAN), targets.map { it.mode })
        assertEquals("https://remote.cpolar.cn", targets.first().origin.serialized)
    }

    @Test
    fun restoresTheLastSuccessfulLanConnectionFirst() {
        val targets = targets(AccessMode.LAN)

        assertEquals(listOf(AccessMode.LAN, AccessMode.REMOTE), targets.map { it.mode })
    }

    @Test
    fun existingInstallWithoutModePrefersRemoteThenFallsBackToLan() {
        val targets = targets(null)

        assertEquals(listOf(AccessMode.REMOTE, AccessMode.LAN), targets.map { it.mode })
    }

    @Test
    fun ignoresExpiredOrMalformedPersistedConnections() {
        val targets = ConnectionRestorePolicy.targets(
            preferredMode = AccessMode.REMOTE,
            lanOrigin = "not-an-origin",
            lanCredential = lanCredential,
            remoteOrigin = "https://remote.cpolar.cn",
            remoteCredential = credential("b", now),
            now = now,
        )

        assertTrue(targets.isEmpty())
    }

    private fun targets(preferredMode: AccessMode?): List<ConnectionRestoreTarget> =
        ConnectionRestorePolicy.targets(
            preferredMode = preferredMode,
            lanOrigin = "https://192.168.1.20:3443",
            lanCredential = lanCredential,
            remoteOrigin = "https://remote.cpolar.cn",
            remoteCredential = remoteCredential,
            now = now,
        )

    private fun credential(instanceCharacter: String, expiresAt: Long) = DeviceCredential(
        instanceId = instanceCharacter.repeat(64),
        deviceToken = "A".repeat(43),
        expiresAt = expiresAt,
        caCertificate = null,
    )
}
