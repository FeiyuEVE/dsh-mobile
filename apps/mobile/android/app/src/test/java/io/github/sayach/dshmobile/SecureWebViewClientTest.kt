package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Test

class SecureWebViewClientTest {
    @Test
    fun remotePagesReceiveALongerMainFrameBudget() {
        assertEquals(30_000L, webViewLoadTimeoutMs("private-name.r8.cpolar.cn"))
        assertEquals(30_000L, webViewLoadTimeoutMs("computer.tail1234.ts.net"))
        assertEquals(15_000L, webViewLoadTimeoutMs("192.168.1.20"))
    }
}
