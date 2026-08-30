package io.github.sayach.dshmobile

import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Boot-time JavaScript polyfills for the gateway's client bundle.
 *
 * The DSH web client calls `AbortSignal.any` (Chrome 116+) and
 * `Promise.withResolvers` (Chrome 119+) during connection setup. Android
 * System WebView on many devices (e.g. Chrome 114 on Android 12) lacks both,
 * which previously made the workspace list never load. The gateway itself
 * must not be patched for the container, so the container injects the missing
 * APIs before the page's own scripts run.
 */
internal const val WEB_COMPAT_POLYFILL_SCRIPT = """
(() => {
  if (typeof AbortSignal.any !== 'function') {
    AbortSignal.any = (signals) => {
      const controller = new AbortController()
      for (const signal of signals) {
        if (signal.aborted) { controller.abort(signal.reason); break }
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
      }
      return controller.signal
    }
  }
  if (typeof Promise.withResolvers !== 'function') {
    Promise.withResolvers = () => {
      let resolve, reject
      const promise = new Promise((res, rej) => { resolve = res; reject = rej })
      return { promise, resolve, reject }
    }
  }
})();
"""

/**
 * Install the boot polyfills for every document of [origin] before the first
 * navigation. Returns false when the current WebView lacks document-start
 * injection (feature [WebViewFeature.DOCUMENT_START_SCRIPT]).
 */
internal fun installWebCompatPolyfills(webView: WebView, origin: GatewayOrigin): Boolean {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return false
    WebViewCompat.addDocumentStartJavaScript(
        webView,
        WEB_COMPAT_POLYFILL_SCRIPT,
        setOf(origin.serialized),
    )
    return true
}
