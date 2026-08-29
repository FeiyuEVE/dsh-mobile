package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SecureWebViewClientTest {
    @Test
    fun remotePagesReceiveALongerMainFrameBudget() {
        assertEquals(30_000L, webViewLoadTimeoutMs("private-name.r8.cpolar.cn"))
        assertEquals(30_000L, webViewLoadTimeoutMs("computer.tail1234.ts.net"))
        assertEquals(15_000L, webViewLoadTimeoutMs("192.168.1.20"))
    }

    @Test
    fun subframesCannotNavigateAcrossOrigins() {
        val origin = GatewayOrigin.parse("https://trusted.example:3443")!!
        assertFalse(shouldBlockSubframeNavigation(origin, "https://trusted.example:3443/embed"))
        assertTrue(shouldBlockSubframeNavigation(origin, "https://other.example/embed"))
        assertTrue(shouldBlockSubframeNavigation(origin, "https://trusted.example/embed"))
    }
}
