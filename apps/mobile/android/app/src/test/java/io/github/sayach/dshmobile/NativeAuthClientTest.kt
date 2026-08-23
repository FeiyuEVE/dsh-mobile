package io.github.sayach.dshmobile

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayInputStream

class NativeAuthClientTest {
    @Test
    fun readsTheCompleteResponseBeforeTheLimit() {
        val source = "discovery".toByteArray()

        assertArrayEquals(source, readAtMost(ByteArrayInputStream(source), source.size + 1))
    }

    @Test
    fun stopsAtTheConfiguredLimit() {
        val source = byteArrayOf(1, 2, 3, 4, 5)

        assertArrayEquals(byteArrayOf(1, 2, 3), readAtMost(ByteArrayInputStream(source), 3))
    }

    @Test
    fun rejectsANegativeLimit() {
        assertThrows(IllegalArgumentException::class.java) {
            readAtMost(ByteArrayInputStream(byteArrayOf()), -1)
        }
    }
}
