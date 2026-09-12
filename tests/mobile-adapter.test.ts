import { describe, expect, it } from 'vitest'
import {
  installMobileAdapterShell,
  MOBILE_ADAPTER_ATTRIBUTE,
  MOBILE_ADAPTER_MEDIA_QUERY,
  readMobileAdapterDeclaration,
  wrapMobileAdapterCss,
} from '../src/mobile-adapter.js'
import { NATIVE_MOBILE_STYLES } from '../src/native-mobile.js'

const shellSource = installMobileAdapterShell.toString()

describe('mobile adapter protocol v1 (edapp adapter shell)', () => {
  it('reads a declaration only from a module export surface that carries one', () => {
    expect(readMobileAdapterDeclaration('a', undefined)).toBeNull()
    expect(readMobileAdapterDeclaration('a', null)).toBeNull()
    expect(readMobileAdapterDeclaration('a', 'css')).toBeNull()
    expect(readMobileAdapterDeclaration('a', {})).toBeNull()
    expect(readMobileAdapterDeclaration('a', { dshMobile: null })).toBeNull()
    expect(readMobileAdapterDeclaration('a', { dshMobile: { css: '   ' } })).toBeNull()
    expect(readMobileAdapterDeclaration('a', { dshMobile: { css: 42, enhance: 'no' } })).toBeNull()
    expect(readMobileAdapterDeclaration('a', { dshMobile: { css: 'html[data-dsh-mobile] .x{width:100%}' } }))
      .toEqual({ id: 'a', css: 'html[data-dsh-mobile] .x{width:100%}', enhance: null })
  })

  it('keeps the declaration object as the enhancer receiver and exposes its disposer', () => {
    const surface = {
      calls: 0,
      disposed: false,
      enhance(this: { calls: number; disposed: boolean }) {
        this.calls += 1
        return () => { this.disposed = true }
      },
    }
    const declaration = readMobileAdapterDeclaration('plugin', { dshMobile: surface })
    expect(declaration?.css).toBeNull()
    const dispose = declaration?.enhance?.()
    expect(surface.calls).toBe(1)
    expect(typeof dispose).toBe('function')
    ;(dispose as () => void)()
    expect(surface.disposed).toBe(true)
  })

  it('toggles an enhancer that returns nothing without treating it as disposable', () => {
    let calls = 0
    const declaration = readMobileAdapterDeclaration('plugin', { dshMobile: { enhance: () => { calls += 1 } } })
    expect(declaration?.enhance?.()).toBeUndefined()
    expect(calls).toBe(1)
  })

  it('wraps the fragment in the protocol viewport gate instead of trusting the plugin', () => {
    // The protocol forbids @media in the fragment: the shell owns the one gate.
    expect(wrapMobileAdapterCss('.x{width:100%}'))
      .toBe(`@media ${MOBILE_ADAPTER_MEDIA_QUERY} {\n.x{width:100%}\n}`)
    expect(MOBILE_ADAPTER_MEDIA_QUERY).toBe('(max-width: 767px)')
  })

  it('mounts the attribute only for the mobile viewport and restores it on teardown', () => {
    expect(MOBILE_ADAPTER_ATTRIBUTE).toBe('data-dsh-mobile')
    expect(shellSource).toContain('root.setAttribute(MOBILE_ADAPTER_ATTRIBUTE, "")')
    expect(shellSource).toContain('root.removeAttribute(MOBILE_ADAPTER_ATTRIBUTE)')
    expect(shellSource).toContain('root.setAttribute(MOBILE_ADAPTER_ATTRIBUTE, previousAttribute)')
    expect(shellSource).toContain('viewport.matches')
    expect(shellSource).toContain('viewport.addEventListener("change", syncViewport)')
    expect(shellSource).toContain('viewport.removeEventListener("change", syncViewport)')
  })

  it('marks injected styles so the module loader cannot claim them from another plugin', () => {
    // claimStyles() adopts every unmarked <style> for whichever module materializes next,
    // and the HMR driver then removes it together with that module.
    expect(shellSource).toContain('style.dataset.plugin = ADAPTER_STYLE_OWNER')
    expect(shellSource).toContain('style.dataset.dshMobileAdapter = entry.id')
  })

  it('rescans the materialized-module table so lazily loaded plugins still get their CSS', () => {
    expect(shellSource).toContain('window.setInterval(scan, MOBILE_ADAPTER_SCAN_INTERVAL_MS)')
    expect(shellSource).toContain('window.clearInterval(timer)')
    expect(shellSource).toContain('cache.has(id)')
    expect(shellSource).toContain('entry.record === record')
  })

  it('keeps every side effect behind the returned disposer', () => {
    expect(shellSource).toContain('deactivate()')
    expect(shellSource).toContain('for (const entry of entries.values()) retire(entry)')
    // A plugin's own enhancer must not be able to strand the shell: a throw leaves no
    // disposer behind instead of propagating out of the scan/activate path.
    expect(shellSource).toMatch(/catch \{\s*entry\.dispose = null/)
  })

  it('gives the conversation tab strip one non-wrapping scrollable row', () => {
    // Without flex:0 0 auto the core strip squeezes all 9+ plugin tabs on a phone
    // (measured: 13px wide buttons), so each CJK label breaks inside its button
    // ("对" stacked over "话") instead of the strip scrolling.
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-header] [class*="_tabs"] { box-sizing:border-box !important; width:max-content !important; max-width:calc(100% - 58px) !important; min-height:28px !important; height:28px !important; margin-top:0 !important; padding-left:6px !important; padding-right:6px !important; gap:18px !important; overflow-x:auto;')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-header] [class*="_tab"] { flex:0 0 auto !important; padding-bottom:5px !important; white-space:nowrap !important; }')
  })
})
