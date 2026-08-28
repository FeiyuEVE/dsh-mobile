package io.github.sayach.dshmobile

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.json.JSONObject
import java.io.ByteArrayInputStream

class NativeAuthClientTest {
    @Test
    fun readsTheCompleteResponseBeforeTheLimit() {
        val source = "discovery".toByteArray()

        assertArrayEquals(source, readAtMost(ByteArrayInputStream(source), source.size + 1))
    }

    @Test
    fun stopsAtTheConfiguredLimit() {
        val source = byteArrayOf(1, 2, 3, 4, 5)

        assertArrayEquals(byteArrayOf(1, 2, 3), readAtMost(ByteArrayInputStream(source), 3))
    }

    @Test
    fun rejectsANegativeLimit() {
        assertThrows(IllegalArgumentException::class.java) {
            readAtMost(ByteArrayInputStream(byteArrayOf()), -1)
        }
    }

    @Test
    fun parsesBoundedCompatibilityMetadata() {
        assertEquals(
            GatewayMetadata(1, "0.3.0", "0.2.2", 1),
            parseGatewayMetadata(JSONObject("""{"version":1,"pluginVersion":"0.3.0","minimumAndroidAppVersion":"0.2.2","discoveryProtocol":1}""")),
        )
        assertNull(parseGatewayMetadata(JSONObject("{}")))
    }

    @Test
    fun classifiesAuthenticationStatusesWithoutExposingServerBodies() {
        assertEquals(NativeAuthFailureKind.PAIRING_EXPIRED, nativeAuthFailureForStatus(401))
        assertEquals(NativeAuthFailureKind.DEVICE_LIMIT, nativeAuthFailureForStatus(409))
        assertEquals(NativeAuthFailureKind.RATE_LIMITED, nativeAuthFailureForStatus(429))
        assertEquals(NativeAuthFailureKind.SERVER_UNAVAILABLE, nativeAuthFailureForStatus(503))
    }

    @Test
    fun allowsRemoteRelaysMoreTimeWithoutSlowingLanFailures() {
        val lan = nativeAuthTimeouts("192.168.1.20")
        val remote = nativeAuthTimeouts("example.r8.cpolar.cn")

        assertEquals(500, lan.bootstrapConnectMs)
        assertEquals(800, lan.bootstrapReadMs)
        assertEquals(3_000, lan.authConnectMs)
        assertEquals(5_000, lan.authReadMs)
        assertEquals(3_000, remote.bootstrapConnectMs)
        assertEquals(5_000, remote.bootstrapReadMs)
        assertEquals(10_000, remote.authConnectMs)
        assertEquals(30_000, remote.authReadMs)
    }

}
