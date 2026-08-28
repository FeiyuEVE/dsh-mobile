import { describe, expect, it } from 'vitest'
import { rewriteMobileIndex } from '../src/gateway.js'
import { MOBILE_LAYOUT_STYLES } from '../src/mobile-layout.js'

function index(entries: unknown[]): string {
  return `<!doctype html><html><head><script>window.__DSH_BOOT__ = ${JSON.stringify({ rev: 'stock', entries })};</script></head><body></body></html>`
}

function currentIndex(entries: unknown[]): string {
  return `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ rev: 'stock', entries })};</script></head><body></body></html>`
}

describe('dedicated mobile layout boot', () => {
  it('replaces only the stock layout bundle and marks the page as dedicated', () => {
    const output = rewriteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime' },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      },
      { id: '@deepseek-ai/dsh-client-ui-conversation', url: '/conversation.js', rev: 'conversation' },
    ]))

    expect(output).toContain('window.__DSH_MOBILE_FRONTEND__="dedicated"')
    expect(output).toContain('window.fetch=(input,init)=>')
    expect(output).toContain('x-dsh-mobile-csrf')
    expect(output.indexOf('window.fetch=(input,init)=>')).toBeLessThan(output.indexOf('window.__DSH_BOOT__'))
    expect(output).toContain('"url":"/mobile-access/mobile-layout.js"')
    expect(output).toContain('"inject":["@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-theme"]')
    expect(output).toContain('"url":"/conversation.js"')
    expect(output).not.toContain('"url":"/layout.js"')
    expect(output).toContain('viewport-fit=cover')
  })

  it('orders the authenticated mobile client before settings without retaining the sidebar cycle', () => {
    const output = rewriteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-connection', url: '/connection.js', rev: 'connection', inject: [] },
      { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime', inject: ['@deepseek-ai/dsh-client-connection'] },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      },
      {
        id: '@deepseek-ai/dsh-client-ui-settings',
        url: '/settings.js',
        rev: 'settings',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-runtime'],
      },
      {
        id: 'dsh-mobile',
        url: '/dsh-mobile.js',
        rev: 'mobile',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
        immediately: true,
      },
    ]))

    expect(output).toContain('"id":"dsh-mobile","url":"/dsh-mobile.js","rev":"mobile","inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-runtime"]')
    expect(output).toContain('"id":"@deepseek-ai/dsh-client-ui-settings","url":"/settings.js","rev":"settings","inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-runtime","dsh-mobile"]')
    expect(output).not.toContain('"id":"dsh-mobile","url":"/dsh-mobile.js","rev":"mobile","inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-ui-sidebar"]')
  })

  it('rebuilds the DSH 0.1.2 application batch around the dedicated layout', () => {
    const entries = [
      { id: '@deepseek-ai/dsh-client-connection', url: '/plugins/connection.js?rev=connection', rev: 'connection', inject: [] },
      { id: '@deepseek-ai/dsh-client-ui-renderer', url: '/plugins/renderer.js?rev=renderer', rev: 'renderer', inject: [] },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/plugins/layout.js?rev=layout',
        rev: 'layout',
        inject: [
          '@deepseek-ai/dsh-client-locale',
          '@deepseek-ai/dsh-client-ui-renderer',
          '@deepseek-ai/dsh-client-ui-session',
          '@deepseek-ai/dsh-client-ui-theme',
        ],
      },
      {
        id: '@deepseek-ai/dsh-client-ui-settings',
        url: '/plugins/settings.js?rev=settings',
        rev: 'settings',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-api-remotes'],
      },
      {
        id: 'dsh-mobile',
        url: '/plugins/dsh-mobile.js?rev=mobile',
        rev: 'mobile',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
        immediately: true,
      },
    ]
    const source = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({
      rev: 'stock',
      entries,
      batches: [{ phase: 'application', url: '/plugins/application.js?rev=stock', rev: 'stock-batch', entries: entries.map(entry => entry.id) }],
    })};</script></head><body></body></html>`
    const output = rewriteMobileIndex(source)

    expect(output).toContain('"url":"/mobile-access/mobile-layout.js"')
    expect(output).toContain('"inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-ui-renderer"]')
    expect(output).toContain('"inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-api-remotes","dsh-mobile"]')
    expect(output).toMatch(/"url":"\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js"/u)
    expect(output).not.toContain('/plugins/application.js?rev=stock')
    expect(output).toContain(`"entries":${JSON.stringify(entries.map(entry => entry.id))}`)
  })

  it('accepts the DSH 0.1.1 global injection syntax', () => {
    const output = rewriteMobileIndex(currentIndex([
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      },
    ]))

    expect(output).toContain('window.__DSH_MOBILE_FRONTEND__="dedicated"')
    expect(output).toContain('globalThis["__DSH_BOOT__"] = {')
    expect(output).toContain('"url":"/mobile-access/mobile-layout.js"')
  })

  it('adapts stable DSH question surfaces for touch screens', () => {
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-question-key]')
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-question-scroll]')
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-plan-review-key]')
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-plan-review-scroll]')
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-plan-review-key]>section>div:last-child')
    expect(MOBILE_LAYOUT_STYLES).toContain('max-height:min(42dvh,360px)')
    expect(MOBILE_LAYOUT_STYLES).toContain('height:auto!important')
    expect(MOBILE_LAYOUT_STYLES).toContain('min-height:44px')
  })

  it('fails closed when the upstream page cannot identify one layout module', () => {
    expect(() => rewriteMobileIndex(index([]))).toThrow('no unique layout module')
    expect(() => rewriteMobileIndex('<html></html>')).toThrow('no boot manifest')
  })

  it('fails closed when the stock layout dependency contract changes', () => {
    expect(() => rewriteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-ui-layout', url: '/layout.js', rev: 'layout', inject: ['new-runtime'] },
    ]))).toThrow('unsupported dependencies')
  })
})
