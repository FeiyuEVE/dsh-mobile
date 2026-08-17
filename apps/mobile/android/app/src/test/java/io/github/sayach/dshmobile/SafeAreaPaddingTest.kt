package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Test

/** Verifies safe-area union and repeat-dispatch behavior without an Android device. */
class SafeAreaPaddingTest {
    @Test
    fun unionsSystemBarsCutoutAndImePerEdge() {
        val systemBars = SafeAreaEdges(left = 0, top = 72, right = 24, bottom = 48)
        val displayCutout = SafeAreaEdges(left = 36, top = 96, right = 0, bottom = 0)
        val ime = SafeAreaEdges(left = 0, top = 0, right = 0, bottom = 840)

        assertEquals(
            SafeAreaEdges(left = 36, top = 96, right = 24, bottom = 840),
            systemBars.union(displayCutout).union(ime),
        )
    }

    @Test
    fun insetRedispatchAlwaysStartsFromOriginalPadding() {
        val original = ContentPadding(left = 8, top = 16, right = 24, bottom = 32)

        assertEquals(
            ContentPadding(left = 8, top = 88, right = 24, bottom = 80),
            original.withSafeArea(SafeAreaEdges(left = 0, top = 72, right = 0, bottom = 48)),
        )
        assertEquals(
            ContentPadding(left = 44, top = 16, right = 48, bottom = 872),
            original.withSafeArea(SafeAreaEdges(left = 36, top = 0, right = 24, bottom = 840)),
        )
        assertEquals(
            original,
            original.withSafeArea(SafeAreaEdges(left = 0, top = 0, right = 0, bottom = 0)),
        )
    }
}
