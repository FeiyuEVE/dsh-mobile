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

internal data class DeviceCredential(
    val instanceId: String,
    val deviceToken: String,
    val expiresAt: Long,
    val caCertificate: ByteArray,
)

/** Encrypts the long-lived device token with a non-exportable Android Keystore key. */
internal class DeviceCredentialStore(context: Context) {
    private val preferences = context.getSharedPreferences("dsh_mobile_device", Context.MODE_PRIVATE)

    fun load(): DeviceCredential? = try {
        val encrypted = Base64.decode(preferences.getString("credential", null), Base64.NO_WRAP)
        val iv = Base64.decode(preferences.getString("iv", null), Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        val fields = String(cipher.doFinal(encrypted), Charsets.UTF_8).split('\n')
        val ca = fields.getOrNull(3)?.let { Base64.decode(it, Base64.NO_WRAP) }
        if (fields.size != 4 || !INSTANCE_ID.matches(fields[0]) || !TOKEN.matches(fields[1]) || ca == null) null
        else PairingTrust.validateCertificate(ca, fields[0])?.let {
            DeviceCredential(fields[0], fields[1], fields[2].toLong(), it)
        }
    } catch (_: Exception) {
        null
    }

    fun save(credential: DeviceCredential) {
        require(INSTANCE_ID.matches(credential.instanceId) && TOKEN.matches(credential.deviceToken))
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        require(PairingTrust.validateCertificate(credential.caCertificate, credential.instanceId) != null)
        val encodedCa = Base64.encodeToString(credential.caCertificate, Base64.NO_WRAP)
        val plaintext = "${credential.instanceId}\n${credential.deviceToken}\n${credential.expiresAt}\n$encodedCa"
        preferences.edit()
            .putString("credential", Base64.encodeToString(cipher.doFinal(plaintext.toByteArray()), Base64.NO_WRAP))
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .apply()
    }

    fun clear() {
        preferences.edit().clear().apply()
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
            generateKey()
        }
    }

    private companion object {
        const val KEY_ALIAS = "dsh_mobile_device_v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        val INSTANCE_ID = Regex("^[a-f0-9]{64}$")
        val TOKEN = Regex("^[A-Za-z0-9_-]{43}$")
    }
}
