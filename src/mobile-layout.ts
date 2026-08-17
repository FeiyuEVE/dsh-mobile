import { createElement, useEffect, useRef, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

interface SessionState {
  readonly current?: string
  readonly byId: Readonly<Record<string, { readonly blank?: boolean } | undefined>>
}

interface MobileRootProps {
  readonly renderSlot: (name: string, owner: Record<string, unknown>) => ReactNode
  readonly useSessions: <T>(selector: (state: SessionState) => T) => T
}

interface MobileClientContext {
  readonly effect: (effect: () => void | (() => void), label?: string) => void
  readonly on: (event: string, listener: (value: ThemeSnapshot) => void) => () => void
  readonly reflect: { provide: (name: string, value: unknown) => () => void | Promise<void> }
  readonly slots: {
    register: (options: Record<string, unknown>, component: (props: MobileRootProps) => ReactNode) => () => void
  }
  readonly theme: { getTheme: () => ThemeSnapshot }
}

interface ThemeSnapshot {
  readonly active: {
    readonly colorScheme: 'dark' | 'light'
    readonly tokens: Readonly<Record<string, string>>
  }
}

interface LayoutSnapshot {
  readonly sidebarOpen: boolean
  readonly detailsOpen: boolean
}

class MobileLayoutController {
  private snapshot: LayoutSnapshot = Object.freeze({ sidebarOpen: false, detailsOpen: false })
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getSnapshot = (): LayoutSnapshot => this.snapshot

  toggleSidebar(): void {
    this.update({ sidebarOpen: !this.snapshot.sidebarOpen })
  }

  openDetails(): void {
    this.update({ detailsOpen: true })
  }

  closeDetails(): void {
    this.update({ detailsOpen: false })
  }

  closeSidebar(): void {
    this.update({ sidebarOpen: false })
  }

  private update(next: Partial<LayoutSnapshot>): void {
    const snapshot = Object.freeze({ ...this.snapshot, ...next })
    if (snapshot.sidebarOpen === this.snapshot.sidebarOpen && snapshot.detailsOpen === this.snapshot.detailsOpen) return
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

class ThemePresenter {
  private appliedTokens: string[] = []
  private readonly meta = document.createElement('meta')

  constructor() {
    this.meta.name = 'theme-color'
  }

  apply(snapshot: ThemeSnapshot): void {
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    document.body.toggleAttribute('data-ds-dark-theme', scheme === 'dark')
    for (const name of this.appliedTokens) document.body.style.removeProperty(name)
    this.appliedTokens = []
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      document.body.style.setProperty(name, value)
      this.appliedTokens.push(name)
    }
    this.meta.content = getComputedStyle(document.body).backgroundColor
    if (!this.meta.isConnected) document.head.append(this.meta)
  }

  dispose(): void {
    document.documentElement.style.removeProperty('color-scheme')
    document.body.removeAttribute('data-ds-dark-theme')
    for (const name of this.appliedTokens) document.body.style.removeProperty(name)
    this.meta.remove()
  }
}

const MOBILE_LAYOUT_STYLES = `
html,body,#root{width:100%;height:100%;overflow:hidden}
.dshm-shell{position:relative;display:grid;width:100%;height:100dvh;min-width:0;overflow:hidden;background:var(--dsw-alias-bg-base,#fff)}
.dshm-main{grid-area:1/1;min-width:0;min-height:0;overflow:hidden}
.dshm-main>*,.dshm-main>*>*{min-width:0}
.dshm-drawer{position:fixed;z-index:70;inset:0 auto 0 0;box-sizing:border-box;width:56px;max-width:100%;padding-top:env(safe-area-inset-top);overflow:hidden;background:var(--dsw-alias-bg-layer-1,#f8fafc);box-shadow:none;transition:width 190ms cubic-bezier(.22,1,.36,1)}
.dshm-drawer[data-open=true]{width:min(88vw,340px);box-shadow:18px 0 46px rgb(15 23 42 / 18%)}
.dshm-drawer[data-open=false]{pointer-events:auto;visibility:visible}
.dshm-drawer>*{width:100%!important;height:100%!important}
.dshm-drawer[data-open=false]>*{width:56px!important}
.dshm-details{position:fixed;z-index:80;inset:0 0 0 auto;box-sizing:border-box;width:min(94vw,460px);max-width:100%;padding-top:env(safe-area-inset-top);overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:-18px 0 46px rgb(15 23 42 / 18%);transform:translateX(104%);transition:transform 190ms cubic-bezier(.22,1,.36,1)}
.dshm-details[data-open=true]{transform:translateX(0)}
.dshm-details[data-open=false]{pointer-events:none;visibility:hidden;transition:transform 190ms cubic-bezier(.22,1,.36,1),visibility 0s linear 190ms}
.dshm-scrim{position:fixed;z-index:65;inset:0;border:0;background:rgb(15 23 42 / 40%);opacity:0;pointer-events:none;transition:opacity 180ms ease-out}
.dshm-scrim[data-open=true]{opacity:1;pointer-events:auto}
.dshm-overlay{position:fixed;z-index:90;inset:0;pointer-events:none}.dshm-overlay>*{pointer-events:auto}
.dshm-shell header{min-width:0;padding-left:52px}
.dshm-shell textarea{font-size:16px}
.dshm-shell table{display:block;max-width:100%;overflow-x:auto}
.dshm-shell pre{max-width:100%;overflow-x:auto}
.dshm-shell img,.dshm-shell video,.dshm-shell canvas,.dshm-shell svg{max-width:100%}
.dshm-shell [data-disclosure-row]{min-width:0;max-width:100%}
.dshm-shell [data-disclosure-row]>*{min-width:0;overflow-wrap:anywhere}
.dshm-shell [data-context-fields]>*{min-width:0}
.dshm-shell [class*="_body"]{max-width:100%;overflow-wrap:anywhere}
@media(max-width:420px){.dshm-shell [data-context-fields]>*{display:grid;grid-template-columns:1fr!important;gap:4px}.dshm-shell [class*="_ioSection"]{grid-template-columns:1fr!important}}
@media(prefers-reduced-motion:reduce){.dshm-drawer,.dshm-details,.dshm-scrim{transition:none!important}}
`

function MobileAppFrame(props: MobileRootProps & { readonly controller: MobileLayoutController }): ReactNode {
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot)
  const suppressKeyboardUntil = useRef(0)
  const hasSession = props.useSessions(session => {
    const current = session.current
    return current !== undefined && session.byId[current]?.blank === false
  })

  useEffect(() => {
    if (!hasSession) props.controller.closeDetails()
  }, [hasSession, props.controller])

  useEffect(() => {
    const suppressAutofocus = (event: FocusEvent): void => {
      if (performance.now() >= suppressKeyboardUntil.current) return
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) target.blur()
    }
    document.addEventListener('focusin', suppressAutofocus, true)
    return () => { document.removeEventListener('focusin', suppressAutofocus, true) }
  }, [])

  const closeDrawerAfterSessionAction = (event: { readonly target: EventTarget | null }): void => {
    if (!(event.target instanceof Element)) return
    const row = event.target.closest<HTMLElement>('[role="treeitem"][aria-selected]')
    const action = event.target.closest('button,[role="button"]')
    const startsSession = action?.matches('button[class*="_newSession"],button[class*="_brand"]') ?? false
    if (row === null && !startsSession) return
    if (row !== null && action !== null && action !== row) return
    suppressKeyboardUntil.current = performance.now() + 500
    // Let the session row finish its own click handler before unmounting the drawer.
    window.setTimeout(() => {
      props.controller.closeSidebar()
      const active = document.activeElement
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.blur()
    }, 0)
  }

  return createElement('div', { className: 'dshm-shell' },
    createElement('main', { className: 'dshm-main' }, props.renderSlot('conversation', {})),
    createElement('button', {
      'aria-label': '关闭浮层',
      className: 'dshm-scrim',
      'data-open': state.sidebarOpen || state.detailsOpen,
      onClick: () => { state.detailsOpen ? props.controller.closeDetails() : props.controller.closeSidebar() },
      tabIndex: state.sidebarOpen || state.detailsOpen ? 0 : -1,
      type: 'button',
    }),
    createElement('aside', {
      'aria-label': '工作区与会话导航',
      className: 'dshm-drawer',
      'data-open': state.sidebarOpen,
      onClickCapture: closeDrawerAfterSessionAction,
    }, props.renderSlot('sidebar', {
      collapsed: !state.sidebarOpen,
      width: state.sidebarOpen ? 340 : 56,
    })),
    createElement('aside', {
      'aria-hidden': !state.detailsOpen,
      className: 'dshm-details',
      'data-open': state.detailsOpen,
      ...(state.detailsOpen ? {} : { inert: '' }),
    }, hasSession ? props.renderSlot('details', {}) : undefined),
    createElement('div', { className: 'dshm-overlay', 'data-shell-overlay': true }, props.renderSlot('shell.overlay', {})),
  )
}

/** Replace the desktop layout module on the authenticated mobile surface. */
export function apply(ctx: MobileClientContext): void {
  const controller = new MobileLayoutController()
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-mobile-layout'
    style.textContent = MOBILE_LAYOUT_STYLES
    document.head.append(style)
    const disposeService = ctx.reflect.provide('layout', controller)
    const disposeRoot = ctx.slots.register({
      name: 'root',
      children: {
        sidebar: { kind: 'single', scope: 'root' },
        conversation: { kind: 'single', scope: 'session-maybe' },
        details: { kind: 'single', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
    }, props => createElement(MobileAppFrame, { ...props, controller }))
    return () => {
      disposeRoot()
      void disposeService()
      style.remove()
    }
  }, 'dsh-mobile: dedicated root layout')

  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', snapshot => { presenter.apply(snapshot) })
    return () => { off(); presenter.dispose() }
  }, 'dsh-mobile: theme presenter')
}

/** Preserve the official layout module's dependency ordering. */
export const inject: readonly string[] = ['slots', 'theme']
