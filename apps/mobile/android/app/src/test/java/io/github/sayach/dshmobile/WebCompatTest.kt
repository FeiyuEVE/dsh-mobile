package io.github.sayach.dshmobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebCompatTest {
    @Test
    fun polyfillScriptGuardsBothMissingApis() {
        assertTrue(WEB_COMPAT_POLYFILL_SCRIPT.contains("typeof AbortSignal.any !== 'function'"))
        assertTrue(WEB_COMPAT_POLYFILL_SCRIPT.contains("AbortSignal.any = (signals)"))
        assertTrue(WEB_COMPAT_POLYFILL_SCRIPT.contains("typeof Promise.withResolvers !== 'function'"))
        assertTrue(WEB_COMPAT_POLYFILL_SCRIPT.contains("Promise.withResolvers = () =>"))
    }

    @Test
    fun polyfillScriptRunsAsAnIife() {
        assertTrue(WEB_COMPAT_POLYFILL_SCRIPT.trimStart().startsWith("(() => {"))
        assertTrue(WEB_COMPAT_POLYFILL_SCRIPT.trimEnd().endsWith("})();"))
    }

    @Test
    fun polyfillScriptNeverClosesAnHtmlScriptTag() {
        // Injected through addDocumentStartJavaScript today, never inlined in
        // HTML; keep that property even if the injection path changes.
        assertFalse(WEB_COMPAT_POLYFILL_SCRIPT.contains("</script"))
    }
}
