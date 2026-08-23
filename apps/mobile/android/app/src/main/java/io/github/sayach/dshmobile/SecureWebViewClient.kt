package io.github.sayach.dshmobile

import android.net.Uri
import android.net.http.SslError
import android.webkit.SafeBrowsingResponse
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

/** Categories of main-frame failures that need a native recovery surface. */
internal enum class LoadFailure {
    TLS,
    NETWORK,
}

/** Enforces exact-origin navigation and optionally accepts the LAN pairing CA. */
internal class SecureWebViewClient(
    private val origin: GatewayOrigin,
    private val caCertificate: ByteArray?,
    private val openExternal: (Uri) -> Unit,
    private val onBlocked: () -> Unit,
    private val onFailure: (LoadFailure) -> Unit,
    private val onLoaded: () -> Unit,
) : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (!request.isForMainFrame) return false
        val candidate = request.url.toString()
        if (GatewayUrlPolicy.isSameOrigin(origin, candidate)) return false
        if (request.hasGesture() && GatewayUrlPolicy.isExternalHttps(candidate)) {
            openExternal(request.url)
        } else {
            onBlocked()
        }
        return true
    }

    override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
        if (url != "about:blank" && !GatewayUrlPolicy.isSameOrigin(origin, url)) {
            view.stopLoading()
            onBlocked()
        }
    }

    override fun onPageFinished(view: WebView, url: String) {
        if (GatewayUrlPolicy.isSameOrigin(origin, url)) onLoaded()
    }

    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        val pinned = caCertificate != null && error.primaryError == SslError.SSL_UNTRUSTED
            && GatewayUrlPolicy.isSameOrigin(origin, error.url)
            && PinnedTls.acceptsWebViewLeaf(origin, caCertificate, error.certificate.x509Certificate)
        if (pinned) {
            handler.proceed()
        } else {
            handler.cancel()
            view.stopLoading()
            onFailure(LoadFailure.TLS)
        }
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (request.isForMainFrame) onFailure(LoadFailure.NETWORK)
    }

    override fun onReceivedHttpError(
        view: WebView,
        request: WebResourceRequest,
        errorResponse: WebResourceResponse,
    ) {
        if (request.isForMainFrame && errorResponse.statusCode >= 400) {
            onFailure(LoadFailure.NETWORK)
        }
    }

    override fun onSafeBrowsingHit(
        view: WebView,
        request: WebResourceRequest,
        threatType: Int,
        callback: SafeBrowsingResponse,
    ) {
        callback.backToSafety(true)
        onFailure(LoadFailure.NETWORK)
    }
}
