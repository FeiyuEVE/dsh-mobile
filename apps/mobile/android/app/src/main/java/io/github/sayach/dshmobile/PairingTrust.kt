package io.github.sayach.dshmobile

import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

internal data class PairingKey(val instanceId: String, val token: String) {
    companion object {
        private val FORMAT = Regex("^dsh1\\.([a-f0-9]{64})\\.([A-Za-z0-9_-]{43})$")

        fun parse(source: String): PairingKey? {
            val match = FORMAT.matchEntire(source) ?: return null
            return PairingKey(match.groupValues[1], match.groupValues[2])
        }
    }
}

internal object PairingTrust {
    /** Validate that the CA is self-signed, valid, and bound to the pairing-key instance id. */
    fun validateCertificate(der: ByteArray, instanceId: String): ByteArray? = runCatching {
        val certificate = certificate(der)
        assertCa(certificate)
        require(fingerprint(certificate) == instanceId)
        certificate.encoded
    }.getOrNull()

    /**
     * Trust a pairing-link CA by its own fingerprint. The pairing URL does not carry
     * the instance id; the fingerprint anchors the exact HTTPS origin the user pasted,
     * matching the key flow where instanceId equals the same CA fingerprint.
     */
    fun trustByOwnFingerprint(der: ByteArray): Pair<ByteArray, String>? = runCatching {
        val certificate = certificate(der)
        assertCa(certificate)
        certificate.encoded to fingerprint(certificate)
    }.getOrNull()

    /** SHA-256 fingerprint of the DER certificate, lowercase hex as used by the gateway. */
    fun fingerprint(certificate: X509Certificate): String =
        MessageDigest.getInstance("SHA-256").digest(certificate.encoded)
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

    private fun certificate(der: ByteArray): X509Certificate =
        CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as X509Certificate

    private fun assertCa(certificate: X509Certificate) {
        certificate.checkValidity()
        require(certificate.basicConstraints >= 0)
        require(certificate.subjectX500Principal == certificate.issuerX500Principal)
        certificate.verify(certificate.publicKey)
    }
}
