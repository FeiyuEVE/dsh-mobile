package io.github.sayach.dshmobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** Runs the language-neutral origin-policy vectors against the Android implementation. */
class GatewayUrlPolicyContractTest {
    private val contract: JSONObject by lazy {
        val resource = javaClass.classLoader?.getResource("url-policy-cases.json")
        assertNotNull("shared URL-policy contract is missing", resource)
        JSONObject(resource!!.readText())
    }

    @Test
    fun normalizationMatchesSharedContract() {
        val cases = contract.getJSONArray("normalization")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val expected = if (case.isNull("expected")) null else case.getString("expected")
            assertEquals(case.getString("name"), expected, GatewayUrlPolicy.normalizeOrigin(case.getString("input")))
        }
    }

    @Test
    fun connectionTargetsMatchSharedContract() {
        val cases = contract.getJSONArray("connections")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val expected = case.optJSONObject("expected")
            val actual = GatewayConnection.parse(case.getString("input"))
            assertEquals(case.getString("name"), expected?.getString("origin"), actual?.origin?.serialized)
            assertEquals(case.getString("name"), expected?.getString("initialURL"), actual?.initialUrl)
        }
    }

    @Test
    fun sameOriginMatchesSharedContract() {
        val cases = contract.getJSONArray("sameOrigin")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val origin = GatewayOrigin.parse(case.getString("base"))
            assertNotNull(case.getString("name"), origin)
            assertEquals(
                case.getString("name"),
                case.getBoolean("expected"),
                GatewayUrlPolicy.isSameOrigin(origin!!, case.getString("candidate")),
            )
        }
    }

    @Test
    fun downloadsMatchSharedContract() {
        val cases = contract.getJSONArray("downloads")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val origin = GatewayOrigin.parse(case.getString("base"))
            assertNotNull(case.getString("name"), origin)
            assertEquals(
                case.getString("name"),
                case.getBoolean("expected"),
                GatewayUrlPolicy.isAllowedDownload(origin!!, case.getString("candidate")),
            )
        }
    }

    @Test
    fun pairingTokenExtractsOnlyTheOneTimeLinkToken() {
        val token = "A".repeat(43)
        assertEquals(token, GatewayUrlPolicy.pairingToken("https://192.168.1.20:3443/mobile-access/pair#token=$token"))

        // A bare pairing key is not a link.
        assertNull(GatewayUrlPolicy.pairingToken("dsh1.${"a".repeat(64)}.${"B".repeat(43)}"))

        // The fixed pairing page without a fragment carries no token.
        assertNull(GatewayUrlPolicy.pairingToken("https://192.168.1.20:3443/mobile-access/pair"))

        // Wrong token length is rejected.
        assertNull(GatewayUrlPolicy.pairingToken("https://192.168.1.20:3443/mobile-access/pair#token=${"C".repeat(42)}"))

        // Any path other than the fixed pairing page is rejected.
        assertNull(GatewayUrlPolicy.pairingToken("https://192.168.1.20:3443/other#token=${"D".repeat(43)}"))
    }
}
