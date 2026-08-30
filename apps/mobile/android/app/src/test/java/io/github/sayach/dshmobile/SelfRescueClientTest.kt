package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Test

class SelfRescueClientTest {
    @Test
    fun okMeansTriggered() {
        assertEquals(SelfRescueOutcome.TRIGGERED, SelfRescueClient.outcomeForStatus(200))
    }

    @Test
    fun conflictMeansAlreadyActive() {
        assertEquals(SelfRescueOutcome.ALREADY_ACTIVE, SelfRescueClient.outcomeForStatus(409))
    }

    @Test
    fun anyOtherStatusMeansFailed() {
        assertEquals(SelfRescueOutcome.FAILED, SelfRescueClient.outcomeForStatus(400))
        assertEquals(SelfRescueOutcome.FAILED, SelfRescueClient.outcomeForStatus(403))
        assertEquals(SelfRescueOutcome.FAILED, SelfRescueClient.outcomeForStatus(404))
        assertEquals(SelfRescueOutcome.FAILED, SelfRescueClient.outcomeForStatus(500))
    }

    @Test
    fun targetPathStaysOnTheConfiguredRemoteOrigin() {
        val origin = GatewayOrigin.parse("https://feiyueve.com:18443")
        assertEquals(
            "https://feiyueve.com:18443/rescue-intake/rescue",
            origin!!.serialized + "/rescue-intake/rescue",
        )
    }
}
