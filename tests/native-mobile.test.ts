import { describe, expect, it } from 'vitest'
import { NATIVE_MOBILE_STYLES } from '../src/native-mobile.js'

describe('native mobile presentation', () => {
  it('keeps touch focus quiet without removing keyboard focus globally', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('data-dsh-mobile-input="touch"')
    expect(NATIVE_MOBILE_STYLES).toContain('-webkit-tap-highlight-color:transparent')
    expect(NATIVE_MOBILE_STYLES).not.toContain('html.dsh-native-mobile-active :focus { outline:none')
  })

  it('stacks narrow settings and conversation metadata instead of squeezing text', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('data-slot="settings.general.item"')
    expect(NATIVE_MOBILE_STYLES).toContain('flex-direction:column !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-disclosure-row]')
    expect(NATIVE_MOBILE_STYLES).toContain('grid-template-columns:16px minmax(0,1fr)')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-context-fields]')
    expect(NATIVE_MOBILE_STYLES).not.toContain('dsh-native-mobile-attach')
  })

  it('uses bounded motion and disables every added animation for reduced motion', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('--dsh-mobile-motion-duration:200ms')
    expect(NATIVE_MOBILE_STYLES).toContain('@keyframes dsh-mobile-view-in')
    expect(NATIVE_MOBILE_STYLES).toContain('@media (prefers-reduced-motion:reduce)')
    expect(NATIVE_MOBILE_STYLES).not.toContain('dsh-native-mobile-sheet')
  })
})
