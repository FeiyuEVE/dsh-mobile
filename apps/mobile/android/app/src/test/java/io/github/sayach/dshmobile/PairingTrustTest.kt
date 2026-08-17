package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingTrustTest {
    @Test
    fun parsesFingerprintBoundPairingKey() {
        val instanceId = "a".repeat(64)
        val token = "B".repeat(43)
        assertEquals(PairingKey(instanceId, token), PairingKey.parse("dsh1.$instanceId.$token"))
    }

    @Test
    fun rejectsLegacyOrMalformedKeys() {
        assertNull(PairingKey.parse("B".repeat(43)))
        assertNull(PairingKey.parse("dsh1.${"g".repeat(64)}.${"B".repeat(43)}"))
    }
}
