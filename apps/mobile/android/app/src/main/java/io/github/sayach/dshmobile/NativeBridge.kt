package io.github.sayach.dshmobile

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.view.Gravity
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Origin-scoped JS bridge for capabilities that belong to Android. Uses
 * addJavascriptInterface so the shell stays free of AndroidX dependencies;
 * the bridge is injected only into the trusted HTTPS gateway origin that the
 * WebView loads, and the page-side adapter exposes a Promise-style API.
 */
class NativeBridge(
    private val activity: Activity,
    private val webView: WebView,
    private val origin: String,
) {
    private data class Pending(val action: String)
    private class PayloadTooLargeException : Exception()

    private val pending = ConcurrentHashMap<String, Pending>()
    private val ioExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private var activityRequestId: String? = null
    private var installed = false

    /** Directional page-scroll observer set by the shell; reports "up" or "down". */
    var onScrollDirection: ((direction: String) -> Unit)? = null

    /** Inject the Java object and install the page-side Promise adapter. */
    @SuppressLint("AddJavascriptInterface")
    fun install(): Boolean {
        if (installed) return true
        webView.addJavascriptInterface(this, JS_OBJECT_NAME)
        installed = true
        injectPage()
        return true
    }

    /** (Re)inject the page adapter after every same-origin top-level navigation. */
    fun injectPage() {
        webView.post { runCatching { webView.evaluateJavascript(pageAdapterScript(), null) } }
    }

    /** Reject pending calls and stop the reader thread when the WebView goes away. */
    fun dispose() {
        installed = false
        activityRequestId = null
        pending.clear()
        ioExecutor.shutdownNow()
    }

    /** Forward Activity Result callbacks for bridge-owned system pickers. */
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != FILE_REQUEST && requestCode != CAMERA_REQUEST) return false
        val requestId = pending.entries.firstOrNull { it.value.action == requestAction(requestCode) }?.key ?: return false
        pending.remove(requestId)
        activityRequestId = null
        if (resultCode != Activity.RESULT_OK) {
            postReply(errorJson("cancelled", "operation cancelled", requestId))
            return true
        }
        // Reading provider-backed files must not happen on the main thread.
        ioExecutor.execute {
            val body = try {
                when (requestCode) {
                    FILE_REQUEST -> fileJson(data?.data)
                    else -> cameraJson(data)
                }
            } catch (_: PayloadTooLargeException) {
                postReply(errorJson("payload_too_large", "selected file is too large", requestId))
                return@execute
            } catch (_: Exception) {
                postReply(errorJson("failed", "native operation failed", requestId))
                return@execute
            }
            postReply(successJson(requestId, body))
        }
        return true
    }

    /** Synchronous entry point called by the page adapter; returns a reply JSON string. */
    @JavascriptInterface
    fun invoke(raw: String): String {
        if (!installed) return errorJson("unavailable", "bridge is unavailable", "")
        if (webView.url?.startsWith(origin) != true) return errorJson("bad_origin", "bridge call outside its origin", "")
        val parsed = try { JSONObject(raw) } catch (_: Exception) { return errorJson("bad_message", "message is invalid", "") }
        if (parsed.optInt("version", 0) != 1) return errorJson("bad_message", "unsupported version", "")
        val requestId = parsed.optString("requestId", "")
        if (requestId.isBlank() || pending.containsKey(requestId) || pending.size >= MAX_PENDING) {
            return errorJson("bad_message", "message is invalid or bridge is busy", requestId)
        }
        val action = parsed.optString("action", "")
        val input = parsed.optJSONObject("input") ?: JSONObject()
        return try {
            when (action) {
                "files.pick" -> startPending(requestId, action) { startFilePicker(input) }
                "camera.capture" -> startPending(requestId, action) { startCamera() }
                "share" -> {
                    activity.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"; putExtra(Intent.EXTRA_TEXT, input.optString("text", ""))
                    }, "Share"))
                    successJson(requestId, JSONObject().put("ok", true))
                }
                "clipboard.read" -> {
                    val manager = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    val text = manager.primaryClip?.getItemAt(0)?.coerceToText(activity)?.toString().orEmpty()
                    successJson(requestId, JSONObject().put("text", text))
                }
                "clipboard.write" -> {
                    val manager = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    manager.setPrimaryClip(ClipData.newPlainText("DSH Mobile", input.optString("text", "")))
                    successJson(requestId, JSONObject().put("ok", true))
                }
                "notification.show" -> {
                    Toast.makeText(activity, input.optString("message", ""), Toast.LENGTH_SHORT).apply {
                        setGravity(Gravity.TOP or Gravity.CENTER_HORIZONTAL, 0, 80)
                        show()
                    }
                    successJson(requestId, JSONObject().put("ok", true))
                }
                else -> errorJson("unsupported", "native capability is unavailable", requestId)
            }
        } catch (_: Exception) {
            errorJson("failed", "native operation failed", requestId)
        }
    }

    @JavascriptInterface
    fun capabilities(): String {
        return """["files.pick","camera.capture","share","clipboard.read","clipboard.write","notification.show"]"""
    }

    /** Scroll direction reported by the injected page adapter, on the UI thread. */
    @JavascriptInterface
    fun onPageScroll(direction: String) {
        if (!installed || webView.url?.startsWith(origin) != true) return
        if (direction != "up" && direction != "down") return
        activity.runOnUiThread { onScrollDirection?.invoke(direction) }
    }

    private fun startPending(requestId: String, action: String, launch: () -> Unit): String {
        if (activityRequestId != null) return errorJson("busy", "another native interaction is active", requestId)
        activityRequestId = requestId
        pending[requestId] = Pending(action)
        try {
            launch()
        } catch (_: Exception) {
            pending.remove(requestId)
            activityRequestId = null
            return errorJson("failed", "native operation failed", requestId)
        }
        return pendingJson(requestId)
    }

    private fun startFilePicker(input: JSONObject) {
        activity.startActivityForResult(Intent.createChooser(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE); type = input.optString("accept", "*/*").ifBlank { "*/*" }
        }, "Choose file"), FILE_REQUEST)
    }

    private fun startCamera() {
        activity.startActivityForResult(Intent.createChooser(Intent("android.media.action.IMAGE_CAPTURE"), "Take photo"), CAMERA_REQUEST)
    }

    private fun postReply(body: String) {
        webView.post { runCatching { webView.evaluateJavascript("window.$JS_OBJECT_NAME_REPLY(${JSONObject.quote(body)})", null) } }
    }

    private fun requestAction(requestCode: Int): String = when (requestCode) {
        FILE_REQUEST -> "files.pick"
        else -> "camera.capture"
    }

    private fun fileJson(uri: Uri?): JSONObject {
        if (uri == null) throw Exception("no file selected")
        val resolver = activity.contentResolver
        val bytes = resolver.openInputStream(uri)?.use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(16 * 1024)
            var total = 0
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                total += count
                if (total > MAX_BINARY_BYTES) throw PayloadTooLargeException()
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        } ?: ByteArray(0)
        val type = resolver.getType(uri) ?: "application/octet-stream"
        return JSONObject().apply { put("name", uri.lastPathSegment ?: "file"); put("type", type); put("base64", Base64.getEncoder().encodeToString(bytes)) }
    }

    private fun cameraJson(data: Intent?): JSONObject {
        val bitmap = data?.extras?.get("data") as? Bitmap ?: throw Exception("camera result unavailable")
        val bytes = ByteArrayOutputStream().use { out -> bitmap.compress(Bitmap.CompressFormat.JPEG, 92, out); out.toByteArray() }
        if (bytes.size > MAX_BINARY_BYTES) throw PayloadTooLargeException()
        return JSONObject().apply {
            put("name", "camera.jpg"); put("type", "image/jpeg"); put("base64", Base64.getEncoder().encodeToString(bytes))
        }
    }

    private fun pageAdapterScript(): String = """
        (() => {
          const bridge = window.$JS_OBJECT_NAME;
          const pending = new Map();
          const materialize = value => { if (!value || typeof value !== 'object' || typeof value.base64 !== 'string' || typeof value.name !== 'string') return value; try { const raw = atob(value.base64); const bytes = Uint8Array.from(raw, char => char.charCodeAt(0)); return new File([bytes], value.name, { type: value.type || 'application/octet-stream' }); } catch (_) { return value; } };
          const handleReply = raw => {
            try {
              const response = JSON.parse(raw);
              const item = pending.get(response.requestId);
              if (!item) return;
              clearTimeout(item.timer);
              pending.delete(response.requestId);
              if (response.ok) item.resolve(materialize(response.value));
              else item.reject(Object.assign(new Error(response.message || response.code), { code: response.code }));
            } catch (_) {}
          };
          window.$JS_OBJECT_NAME_REPLY = handleReply;
          window.__DSH_MOBILE_NATIVE__ = {
            capabilities: () => Promise.resolve(JSON.parse(bridge.capabilities())),
            invoke: (action, input = {}) => new Promise((resolve, reject) => {
              const requestId = crypto.randomUUID();
              const timer = setTimeout(() => { const item = pending.get(requestId); if (item) { clearTimeout(item.timer); pending.delete(requestId); item.reject(Object.assign(new Error('native capability timed out'), { code: 'timeout' })); } }, 60000);
              pending.set(requestId, { resolve, reject, timer });
              const raw = bridge.invoke(JSON.stringify({ version: 1, requestId, action, input }));
              if (raw) handleReply(raw);
            })
          };

          // Throttled directional scroll feed so the shell can hide its toolbar.
          // capture:true also observes scrolling inside nested containers; when the
          // page scrolls an internal box instead of the window, the delta stays
          // ~0 and the callback simply does not fire (toolbar stays put).
          let lastScrollY = Math.max(0, (document.scrollingElement || document.documentElement).scrollTop || 0);
          let lastScrollAt = 0;
          const onPageScroll = () => {
            const now = Date.now();
            if (now - lastScrollAt < 120) return;
            lastScrollAt = now;
            const scroller = document.scrollingElement || document.documentElement;
            const y = Math.max(0, scroller.scrollTop || 0);
            const delta = y - lastScrollY;
            lastScrollY = y;
            if (delta > 4) { try { bridge.onPageScroll('down'); } catch (_) {} }
            else if (delta < -4) { try { bridge.onPageScroll('up'); } catch (_) {} }
          };
          document.addEventListener('scroll', onPageScroll, { passive: true, capture: true });
        })();
    """.trimIndent()
        .replace("$JS_OBJECT_NAME", JS_OBJECT_NAME)
        .replace("$JS_OBJECT_NAME_REPLY", JS_OBJECT_NAME_REPLY)

    private fun successJson(requestId: String, value: JSONObject): String =
        JSONObject().apply { put("requestId", requestId); put("ok", true); put("value", value) }.toString()

    private fun errorJson(code: String, message: String, requestId: String): String =
        JSONObject().apply { put("requestId", requestId); put("ok", false); put("code", code); put("message", message) }.toString()

    private fun pendingJson(requestId: String): String =
        JSONObject().apply { put("requestId", requestId); put("ok", false); put("code", "pending") }.toString()

    private companion object {
        const val JS_OBJECT_NAME = "dshMobileNative"
        const val JS_OBJECT_NAME_REPLY = "__dshMobileNativeReply"
        const val MAX_MESSAGE_BYTES = 1024 * 1024
        const val MAX_BINARY_BYTES = 700 * 1024
        const val MAX_PENDING = 16
        const val FILE_REQUEST = 5101
        const val CAMERA_REQUEST = 5102
    }
}
