package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionIssuePolicyTest {
    @Test
    fun classifiesActionableMainFrameHttpFailures() {
        assertEquals(LoadFailure.AUTH_EXPIRED, loadFailureForHttpStatus(401))
        assertEquals(LoadFailure.RATE_LIMITED, loadFailureForHttpStatus(429))
        assertEquals(LoadFailure.SERVICE_UNAVAILABLE, loadFailureForHttpStatus(503))
        assertEquals(LoadFailure.NETWORK, loadFailureForHttpStatus(404))
    }

    @Test
    fun declinesNearbyPermissionWithoutDisablingFallbackDiscovery() {
        assertTrue(NearbyDiscoveryPermissionPolicy.shouldRequest(33, granted = false, previouslyDeclined = false))
        assertFalse(NearbyDiscoveryPermissionPolicy.shouldRequest(33, granted = false, previouslyDeclined = true))
        assertFalse(NearbyDiscoveryPermissionPolicy.shouldRequest(33, granted = true, previouslyDeclined = true))
        assertFalse(NearbyDiscoveryPermissionPolicy.shouldRequest(32, granted = false, previouslyDeclined = false))
    }
}
