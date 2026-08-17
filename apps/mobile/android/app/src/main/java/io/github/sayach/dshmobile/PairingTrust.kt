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
    fun validateCertificate(der: ByteArray, instanceId: String): ByteArray? = runCatching {
        val certificate = CertificateFactory.getInstance("X.509")
            .generateCertificate(ByteArrayInputStream(der)) as X509Certificate
        certificate.checkValidity()
        require(certificate.basicConstraints >= 0)
        require(certificate.subjectX500Principal == certificate.issuerX500Principal)
        certificate.verify(certificate.publicKey)
        val fingerprint = MessageDigest.getInstance("SHA-256").digest(certificate.encoded)
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
        require(fingerprint == instanceId)
        certificate.encoded
    }.getOrNull()
}
