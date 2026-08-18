package io.github.sayach.dshmobile

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.hardware.Camera
import android.os.Bundle
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast

/**
 * Full-screen QR scanner for the low-friction pairing path. Uses the legacy
 * android.hardware.Camera API plus ZXing so the shell stays free of AndroidX
 * dependencies; the CAMERA permission is requested by MainActivity before launch.
 */
class ScanActivity : Activity(), SurfaceHolder.Callback {
    private var camera: Camera? = null
    private var previewWidth = 0
    private var previewHeight = 0
    private var previewReady = false
    private var decoding = false
    private var finished = false
    private lateinit var preview: SurfaceView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildInterface())
        preview.holder.addCallback(this)
    }

    override fun onResume() {
        super.onResume()
        if (previewReady && camera == null) openCamera()
    }

    override fun onPause() {
        releaseCamera()
        super.onPause()
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        previewReady = true
        openCamera()
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = Unit

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        previewReady = false
        releaseCamera()
    }

    private fun buildInterface(): View {
        val density = resources.displayMetrics.density
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        val surface = SurfaceView(this)
        preview = surface
        root.addView(surface, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

        val frameDrawable = GradientDrawable().apply {
            setColor(Color.TRANSPARENT)
            setStroke((2 * density).toInt(), Color.WHITE)
        }
        val frameView = View(this).apply { background = frameDrawable }
        val frameSize = (260 * density).toInt()
        root.addView(
            frameView,
            FrameLayout.LayoutParams(frameSize, frameSize, Gravity.CENTER),
        )

        val hint = TextView(this).apply {
            text = getString(R.string.scan_hint)
            setTextColor(Color.WHITE)
            textSize = 15f
            gravity = Gravity.CENTER
        }
        root.addView(
            hint,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL,
            ).apply {
                bottomMargin = (48 * density).toInt()
            },
        )

        val close = ImageButton(this).apply {
            setImageResource(android.R.drawable.ic_menu_close_clear_cancel)
            setBackgroundColor(Color.TRANSPARENT)
            setOnClickListener { finish() }
        }
        root.addView(
            close,
            FrameLayout.LayoutParams(
                (48 * density).toInt(),
                (48 * density).toInt(),
                Gravity.TOP or Gravity.START,
            ).apply {
                topMargin = (24 * density).toInt()
                startMargin = (16 * density).toInt()
            },
        )
        return root
    }

    private fun openCamera() {
        if (finished) return
        val cam = runCatching { Camera.open(0) }.getOrNull()
        if (cam == null) {
            runOnUiThread { Toast.makeText(this, R.string.camera_unavailable, Toast.LENGTH_LONG).show() }
            finish()
            return
        }
        camera = cam
        try {
            val params = cam.parameters
            val supported = params.supportedFocusModes
            if (supported != null && supported.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                params.focusMode = Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE
            } else if (supported != null && supported.contains(Camera.Parameters.FOCUS_MODE_AUTO)) {
                params.focusMode = Camera.Parameters.FOCUS_MODE_AUTO
            }
            // Explicitly pick a preview size close to 720p; unset previewSize can be null.
            val sizes = params.supportedPreviewSizes
            val size = if (sizes != null && sizes.isNotEmpty()) {
                sizes.minByOrNull { kotlin.math.abs(it.width - 1280) + kotlin.math.abs(it.height - 720) } ?: sizes[0]
            } else {
                null
            }
            if (size == null) throw IllegalStateException("camera has no preview size")
            params.setPreviewSize(size.width, size.height)
            cam.parameters = params
            previewWidth = size.width
            previewHeight = size.height
            cam.setDisplayOrientation(90)
            cam.setPreviewDisplay(preview.holder)
            cam.setPreviewCallback { data, _ -> onPreviewFrame(data) }
            cam.startPreview()
        } catch (error: Exception) {
            releaseCamera()
            runOnUiThread { Toast.makeText(this, R.string.camera_unavailable, Toast.LENGTH_LONG).show() }
            finish()
        }
    }

    private fun onPreviewFrame(data: ByteArray) {
        if (decoding || finished || camera == null) return
        decoding = true
        try {
            val text = QrDecoder.decodeNv21(data, previewWidth, previewHeight)
            if (text != null) {
                finished = true
                setResult(RESULT_OK, Intent().putExtra(EXTRA_QR_RESULT, text))
                finish()
            }
        } finally {
            decoding = false
        }
    }

    private fun releaseCamera() {
        val cam = camera ?: return
        camera = null
        runCatching { cam.setPreviewCallback(null) }
        runCatching { cam.stopPreview() }
        cam.release()
    }

    companion object {
        const val EXTRA_QR_RESULT = "qr_result"
    }
}
