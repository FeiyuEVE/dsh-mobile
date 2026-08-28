package io.github.sayach.dshmobile

import android.view.View
import android.view.Window

/** Selects dark status-bar glyphs when the synchronized Web background is light. */
internal fun statusBarUsesDarkIcons(color: Int): Boolean {
    val red = color shr 16 and 0xff
    val green = color shr 8 and 0xff
    val blue = color and 0xff
    return red * 299 + green * 587 + blue * 114 >= 186_000
}

/** Matches status-bar icon contrast to the App-owned background strip. */
@Suppress("DEPRECATION")
internal fun applyStatusBarIconContrast(window: Window, color: Int) {
    val darkIcons = statusBarUsesDarkIcons(color)
    window.decorView.systemUiVisibility = if (darkIcons) {
        window.decorView.systemUiVisibility or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
    } else {
        window.decorView.systemUiVisibility and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
    }
}
