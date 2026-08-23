package io.github.sayach.dshmobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val DEVICE_CREDENTIAL_KEY_ALIAS = "dsh_mobile_device_v1"

internal data class DeviceCredential(
    val instanceId: String,
    val deviceToken: String,
    val expiresAt: Long,
    val caCertificate: ByteArray?,
)

/** Encrypts the long-lived device token with a non-exportable Android Keystore key. */
internal class DeviceCredentialStore(context: Context, private val slot: String = "lan") {
    private val preferences = context.getSharedPreferences(
        if (slot == "lan") "dsh_mobile_device" else "dsh_mobile_device_$slot",
        Context.MODE_PRIVATE,
    )

    fun load(): DeviceCredential? {
        val encrypted = runCatching {
            Base64.decode(preferences.getString("credential", null), Base64.NO_WRAP)
        }.getOrNull() ?: return null
        val iv = runCatching {
            Base64.decode(preferences.getString("iv", null), Base64.NO_WRAP)
        }.getOrNull() ?: return null
        val aliases = buildList {
            add(deviceCredentialKeyAlias(slot))
            if (slot != "lan") add(DEVICE_CREDENTIAL_KEY_ALIAS)
        }.distinct()
        for (alias in aliases) {
            val secretKey = existingKey(alias) ?: continue
            val credential = decrypt(encrypted, iv, secretKey) ?: continue
            if (alias != deviceCredentialKeyAlias(slot)) {
                runCatching { save(credential) }
            }
            return credential
        }
        return null
    }

    fun save(credential: DeviceCredential) {
        require(INSTANCE_ID.matches(credential.instanceId) && TOKEN.matches(credential.deviceToken))
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encodedCa = credential.caCertificate?.let {
            require(PairingTrust.validateCertificate(it, credential.instanceId) != null)
            Base64.encodeToString(it, Base64.NO_WRAP)
        } ?: PUBLIC_TLS.also { require(slot != "lan") }
        val plaintext = "${credential.instanceId}\n${credential.deviceToken}\n${credential.expiresAt}\n$encodedCa"
        preferences.edit()
            .putString("credential", Base64.encodeToString(cipher.doFinal(plaintext.toByteArray()), Base64.NO_WRAP))
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .apply()
    }

    fun clear() {
        preferences.edit().clear().apply()
    }

    private fun decrypt(encrypted: ByteArray, iv: ByteArray, secretKey: SecretKey): DeviceCredential? {
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(128, iv))
            val fields = String(cipher.doFinal(encrypted), Charsets.UTF_8).split('\n')
            if (fields.size != 4 || !INSTANCE_ID.matches(fields[0]) || !TOKEN.matches(fields[1])) return null
            val expiresAt = fields[2].toLongOrNull() ?: return null
            val ca = fields[3].takeUnless { it == PUBLIC_TLS }?.let { Base64.decode(it, Base64.NO_WRAP) }
            if (slot == "lan" && ca == null) return null
            if (ca == null) DeviceCredential(fields[0], fields[1], expiresAt, null)
            else PairingTrust.validateCertificate(ca, fields[0])?.let {
                DeviceCredential(fields[0], fields[1], expiresAt, it)
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val alias = deviceCredentialKeyAlias(slot)
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
            generateKey()
        }
    }

    private fun existingKey(alias: String): SecretKey? = runCatching {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        store.getKey(alias, null) as? SecretKey
    }.getOrNull()

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val PUBLIC_TLS = "-"
        val INSTANCE_ID = Regex("^[a-f0-9]{64}$")
        val TOKEN = Regex("^[A-Za-z0-9_-]{43}$")
    }
}

/** Returns the stable Android Keystore alias for one credential slot. */
internal fun deviceCredentialKeyAlias(slot: String): String =
    if (slot == "lan") DEVICE_CREDENTIAL_KEY_ALIAS else "${DEVICE_CREDENTIAL_KEY_ALIAS}_$slot"
