package io.github.sayach.dshmobile

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

internal enum class SelfRescueOutcome { TRIGGERED, ALREADY_ACTIVE, FAILED }

/**
 * Fires the manual self-rescue request at the supervisor's public intake
 * endpoint (`POST /rescue-intake/rescue` on the remote gateway origin). The
 * endpoint is independent of the DSH web process (frps nginx -> frp tunnel ->
 * supervisor), so it works even when the web profile failed to start. TLS
 * trust mirrors the pairing bootstrap: the gateway uses a self-signed CA, so
 * the request trusts the leaf without verification (the endpoint carries no
 * secrets). Runs on a caller-provided background thread; never touch the UI
 * thread from here.
 */
internal object SelfRescueClient {
    private const val PATH = "/rescue-intake/rescue"
    private const val CONNECT_TIMEOUT_MS = 10_000
    private const val READ_TIMEOUT_MS = 15_000

    fun trigger(origin: GatewayOrigin): SelfRescueOutcome {
        val trustManager = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        }
        val context = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf(trustManager), SecureRandom())
        }
        val connection = URL(origin.serialized + PATH).openConnection() as HttpsURLConnection
        try {
            connection.sslSocketFactory = context.socketFactory
            connection.requestMethod = "POST"
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.instanceFollowRedirects = false
            connection.doOutput = true
            connection.setRequestProperty("content-type", "text/plain")
            val body = JSONObject()
                .put("source", "android-app")
                .put("kind", "manual-rescue")
                .put("message", "user tapped the self-rescue button in the mobile app")
                .put("ts", System.currentTimeMillis())
                .toString()
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            return outcomeForStatus(connection.responseCode)
        } finally {
            connection.disconnect()
        }
    }

    internal fun outcomeForStatus(status: Int): SelfRescueOutcome = when (status) {
        HttpURLConnection.HTTP_OK -> SelfRescueOutcome.TRIGGERED
        HttpURLConnection.HTTP_CONFLICT -> SelfRescueOutcome.ALREADY_ACTIVE
        else -> SelfRescueOutcome.FAILED
    }
}
