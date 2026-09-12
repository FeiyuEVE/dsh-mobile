import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { rewriteMobileIndex } from '../src/gateway.js'
import { MOBILE_LAYOUT_MESSAGES, MOBILE_LAYOUT_STYLES, apply, resolveMobileLayoutLanguage } from '../src/mobile-layout.js'

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

  it('injects session recovery ahead of the boot manifest', () => {
    const output = rewriteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime' },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      },
    ]))

    // The page's Session Cookie lives in the gateway's memory, so restarting the host kills it while
    // the open page keeps its DOM. Every request then answers 401 and the live channel retries
    // forever; the injected bootstrap is what turns that state back into a working session.
    expect(output).toContain('/mobile-access/auth/renew')
    expect(output).toContain("credentials:'same-origin'")
    expect(output).toContain('window.WebSocket')
    expect(output).toContain("addEventListener('error'")
    expect(output).toContain('"/mobile-access/login"')
    expect(output).toContain("'?return='+encodeURIComponent(location.pathname+location.search)")
    expect(output).toContain('response.status!==401')
    expect(output.indexOf('/mobile-access/auth/renew')).toBeLessThan(output.indexOf('window.__DSH_BOOT__'))
  })

  it('leaves old-WebView polyfills to the host app instead of injecting a second copy', () => {
    const output = rewriteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime' },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      },
    ]))

    // Old-WebView polyfills are the Flutter host's job (`_webViewCompatScript`, injected at
    // document start ahead of every bundle). The served page must not carry a second copy:
    // one owner for the engine gap, and the gateway rewrite stays limited to the layout module.
    expect(output).not.toContain("typeof Iterator==='undefined'")
    expect(output).not.toContain("typeof Promise.try!=='function'")
    expect(output).not.toContain("typeof Math.sumPrecise!=='function'")
    expect(output).not.toContain("typeof Uint8Array.fromBase64!=='function'")
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
        // The client module id IS the npm package name (client-modules rejects any other id).
        id: '@feiyueve/dsh-mobile',
        url: '/dsh-mobile.js',
        rev: 'mobile',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
        immediately: true,
      },
    ]))

    expect(output).toContain('"id":"@feiyueve/dsh-mobile","url":"/dsh-mobile.js","rev":"mobile","inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-runtime"]')
    expect(output).toContain('"id":"@deepseek-ai/dsh-client-ui-settings","url":"/settings.js","rev":"settings","inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-runtime","@feiyueve/dsh-mobile"]')
    expect(output).not.toContain('"id":"@feiyueve/dsh-mobile","url":"/dsh-mobile.js","rev":"mobile","inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-ui-sidebar"]')
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
        id: '@feiyueve/dsh-mobile',
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
    expect(output).toContain('"inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-api-remotes","@feiyueve/dsh-mobile"]')
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

  it('selects and localizes the dedicated layout language', () => {
    expect(resolveMobileLayoutLanguage('it-IT', ['en-US'])).toBe('it')
    expect(resolveMobileLayoutLanguage('zh-CN', ['it-IT', 'en-US'])).toBe('zh')
    expect(resolveMobileLayoutLanguage('', ['en-GB'])).toBe('en')
    expect(resolveMobileLayoutLanguage('', ['fr-FR'])).toBe('en')
    expect(MOBILE_LAYOUT_MESSAGES.it).toEqual({
      closePanels: 'Chiudi pannelli',
      workspaceNavigation: 'Navigazione area di lavoro e sessioni',
    })
    expect(MOBILE_LAYOUT_MESSAGES.en.closePanels).toBe('Close panels')
    expect(MOBILE_LAYOUT_MESSAGES.zh.workspaceNavigation).toBe('工作区与会话导航')
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

  it('opens the command menu without restoring focus to the mobile editor', () => {
    const source = readFileSync(new URL('../src/mobile-layout.ts', import.meta.url), 'utf8')
    expect(source).toContain("event.target.closest('button[aria-haspopup=\"listbox\"]')")
    expect(source).toContain("target.matches('input,textarea') || target.isContentEditable")
    expect(source).toContain("active.matches('input,textarea') || active.isContentEditable")
  })

  it('fails closed when the upstream page cannot identify one layout module', () => {
    expect(() => rewriteMobileIndex(index([]))).toThrow('no unique layout module')
    expect(() => rewriteMobileIndex('<html></html>')).toThrow('no boot manifest')
  })

  it('drops the stock combined-bundle preload the rewritten page can never use', () => {
    // 上游为「即将执行的那一个合并 bundle」发 preload；本网关把它替换成自己的
    // content-addressed batch，那个 preload 永远不会被消费——实测仍会白下 4.5 MB。
    const source = `<!doctype html><html><head><link rel="preload" as="script" href="/plugins/??@deepseek-ai/dsh-client-connection/client.js,@deepseek-ai/dsh-client-ui-renderer/client.js&rev=abc"><link rel="preload" as="style" href="/assets/app.css"><script>window.__DSH_BOOT__ = ${JSON.stringify({ rev: 'stock', entries: [{ id: '@deepseek-ai/dsh-client-ui-layout', url: '/layout.js', rev: 'layout', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'] }] })};</script></head><body></body></html>`
    const output = rewriteMobileIndex(source)
    expect(output).not.toContain('/plugins/??')
    // 其它 preload 不动
    expect(output).toContain('<link rel="preload" as="style" href="/assets/app.css">')
  })

  it('fails closed when the stock layout dependency contract changes', () => {
    expect(() => rewriteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-ui-layout', url: '/layout.js', rev: 'layout', inject: ['new-runtime'] },
    ]))).toThrow('unsupported dependencies')
  })
})

/**
 * The dedicated mobile layout REPLACES the stock `@deepseek-ai/dsh-client-ui-layout` module, so it
 * inherits that module's root contribution duties. `usePanelInfo` is one of them: the slot runtime
 * materializes each root hook source into the standard prop `use<Name>` for every descendant entry
 * (ui-slots `standardHookPropName`), and ui-sidebar's PanelRow/SessionTree call it. Without the
 * contribution they receive `undefined` and the whole `sidebar.workspaces` entry throws
 * `TypeError: usePanelInfo is not a function` — the drawer renders every control except the
 * session list, and the page itself reports no HTTP or console error outside the slot boundary.
 */
describe('dedicated mobile layout root contributions', () => {
  interface PanelInfoSource {
    getSnapshot: () => { readonly activePanelId: string | null }
    subscribe: (listener: () => void) => () => void
  }

  interface FakeClientContext {
    readonly ctx: Parameters<typeof apply>[0]
    readonly contributions: { readonly hooks: Record<string, unknown> }[]
    readonly layout: { selectPanel: (panelId: string | null) => void }
    readonly teardown: () => void
    readonly disposals: string[]
  }

  /** Minimal DOM stand-in: `apply()` only writes a <style> plus the theme presenter's tokens. */
  function installFakeDom(): () => void {
    const styleProperties = (): Record<string, unknown> => ({ setProperty: () => {}, removeProperty: () => {} })
    const chrome = {
      createElement: (tag: string) => (tag === 'meta'
        ? { name: '', content: '', isConnected: false, remove: () => {} }
        : { dataset: {} as Record<string, string>, textContent: '', remove: () => {} }),
      head: { append: () => {} },
      body: { style: styleProperties(), toggleAttribute: () => {}, removeAttribute: () => {} },
      documentElement: { style: styleProperties() },
    }
    const host = globalThis as unknown as Record<string, unknown>
    const previous = { document: host['document'], getComputedStyle: host['getComputedStyle'] }
    host['document'] = chrome
    host['getComputedStyle'] = () => ({ backgroundColor: 'rgb(255,255,255)' })
    return () => {
      host['document'] = previous.document
      host['getComputedStyle'] = previous.getComputedStyle
    }
  }

  function createFakeClientContext(): FakeClientContext {
    const contributions: { readonly hooks: Record<string, unknown> }[] = []
    const disposals: string[] = []
    const cleanups: (() => void)[] = []
    let controller: { selectPanel: (panelId: string | null) => void } | undefined
    const ctx = {
      // Cordis runs the effect body and keeps its returned cleanup; the test only needs the latter.
      effect: (body: () => void | (() => void)) => {
        const cleanup = body()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      },
      on: () => () => {},
      reflect: {
        provide: (name: string, value: unknown) => {
          if (name === 'layout') controller = value as { selectPanel: (panelId: string | null) => void }
          return () => { disposals.push(`service:${name}`) }
        },
      },
      slots: {
        provideRoot: (contribution: { readonly hooks: Record<string, unknown> }) => {
          contributions.push(contribution)
          return () => { disposals.push('panelInfo') }
        },
        register: () => () => { disposals.push('root') },
      },
      theme: { getTheme: () => ({ active: { colorScheme: 'light', tokens: {} } }) },
    }
    return {
      ctx: ctx as unknown as Parameters<typeof apply>[0],
      contributions,
      get layout() {
        if (controller === undefined) throw new Error('apply() did not provide the layout service')
        return controller
      },
      teardown: () => { for (const cleanup of cleanups) cleanup() },
      disposals,
    }
  }

  it('provides the root panelInfo hook owned by the stock layout module it replaces', () => {
    const restoreDom = installFakeDom()
    try {
      const fake = createFakeClientContext()
      apply(fake.ctx)

      expect(fake.contributions).toHaveLength(1)
      const panelInfo = fake.contributions[0]?.hooks['panelInfo'] as PanelInfoSource | undefined
      expect(panelInfo).toBeDefined()
      expect(typeof panelInfo?.getSnapshot).toBe('function')
      expect(typeof panelInfo?.subscribe).toBe('function')
      const source = panelInfo as PanelInfoSource

      // useSyncExternalStore compares snapshots by Object.is: a fresh object per call would spin
      // the renderer forever, so an unchanged panel must keep its snapshot identity.
      const initial = source.getSnapshot()
      expect(initial).toEqual({ activePanelId: null })
      expect(source.getSnapshot()).toBe(initial)

      const notifications: string[] = []
      source.subscribe(() => { notifications.push('changed') })
      fake.layout.selectPanel('settings')
      const selected = source.getSnapshot()
      expect(selected).toEqual({ activePanelId: 'settings' })
      expect(source.getSnapshot()).toBe(selected)
      expect(notifications).toEqual(['changed'])

      fake.teardown()
      expect(fake.disposals).toContain('panelInfo')
    } finally {
      restoreDom()
    }
  })
})
