import { createElement } from 'react'
import { installNativeMobileSurface, NATIVE_MOBILE_STYLES } from './native-mobile.js'

interface ClientContext {
  effect(effect: () => void | (() => void), label?: string): void
  slots: {
    inject(key: string, callback: () => (() => void)): () => void
    register(options: { name: string; id: string }, component: (props: { wide: boolean }) => unknown): () => void
  }
}

interface MobileExtensionContext {
  readonly document: Document
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly root: HTMLElement
  readonly window: Window
}

type MobileExtensionMount = (context: MobileExtensionContext) => void | (() => void)

declare global {
  interface Window {
    dshMobile?: { register(mount: MobileExtensionMount): void }
    __DSH_MOBILE_FRONTEND__?: 'dedicated'
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  return node
}

async function requestJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
  const body = await response.json() as Record<string, unknown>
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${String(response.status)}`)
  return body
}

function installControl(): { remove: () => void; toggle: () => void } {
  const root = element('div', 'dsh-mobile-control')
  const panel = element('section', 'dsh-mobile-control__panel'); panel.hidden = true
  panel.setAttribute('aria-label', '移动访问')
  const header = element('header', 'dsh-mobile-control__header')
  const title = element('h2'); title.textContent = '移动访问'
  const close = element('button', 'dsh-mobile-control__close'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '收起移动访问')
  const access = element('div', 'dsh-mobile-control__access'); access.hidden = true
  const accessLabel = element('span', 'dsh-mobile-control__access-label'); accessLabel.textContent = '浏览器访问'
  const accessLink = element('a', 'dsh-mobile-control__access-link'); accessLink.target = '_blank'; accessLink.rel = 'noreferrer'
  access.append(accessLabel, accessLink)
  const qrBox = element('div', 'dsh-mobile-control__qr'); qrBox.hidden = true
  const status = element('p', 'dsh-mobile-control__status'); status.textContent = '正在读取状态…'
  const actions = element('div', 'dsh-mobile-control__actions')
  const toggle = element('button', 'dsh-mobile-control__secondary'); toggle.type = 'button'
  const pair = element('button', 'dsh-mobile-control__primary'); pair.type = 'button'; pair.textContent = '生成并复制密钥'
  const linkPair = element('button', 'dsh-mobile-control__secondary'); linkPair.type = 'button'; linkPair.textContent = '复制配对链接'
  const manageRow = element('div', 'dsh-mobile-control__manage-row')
  const manageDevices = element('button', 'dsh-mobile-control__manage'); manageDevices.type = 'button'; manageDevices.textContent = '管理配对设备'
  const resetAll = element('button', 'dsh-mobile-control__manage'); resetAll.type = 'button'; resetAll.textContent = '清除所有设备'
  manageRow.append(manageDevices, resetAll)
  const devicePanel = element('div', 'dsh-mobile-control__devices'); devicePanel.hidden = true
  header.append(title, close); actions.append(toggle, pair, linkPair); panel.append(header, access, qrBox, status, actions, manageRow, devicePanel); root.append(panel); document.body.append(root)
  let running = false
  let origin = ''
  const setOpen = (open: boolean): void => {
    panel.hidden = !open
    for (const trigger of document.querySelectorAll('.dsh-mobile-control__trigger')) trigger.setAttribute('aria-expanded', String(open))
  }
  const render = (data: Record<string, unknown>): void => {
    running = data.running === true
    origin = running && typeof data.origin === 'string' ? data.origin : ''
    access.hidden = origin === ''
    accessLink.href = origin
    accessLink.textContent = origin
    accessLink.title = origin
    status.classList.toggle('is-running', running)
    status.textContent = running ? '移动访问已开启。' : '已关闭。DSH 仍只在本机可用。'
    if (!running) qrBox.hidden = true
    toggle.textContent = running ? '关闭移动访问' : '开启移动访问'
    pair.disabled = !running
    linkPair.disabled = !running
    manageDevices.disabled = !running
    resetAll.disabled = !running
  }
  const showQr = (svg: string): void => {
    qrBox.replaceChildren()
    if (svg === '') { qrBox.hidden = true; return }
    const image = element('img')
    image.alt = '配对二维码'
    image.width = 176
    image.height = 176
    image.src = `data:image/svg+xml;base64,${btoa(svg)}`
    qrBox.hidden = false
    qrBox.append(image)
  }
  const openPairing = (target: 'key' | 'link'): void => {
    void requestJson('/api/mobile-access/pairing/open', { method: 'POST', body: '{}' }).then(async data => {
      const value = target === 'key'
        ? (typeof data.appKey === 'string' ? data.appKey : '')
        : (typeof data.pairUrl === 'string' ? data.pairUrl : '')
      showQr(typeof data.qrSvg === 'string' ? data.qrSvg : '')
      if (value === '') { status.textContent = '无法生成配对密钥。'; return }
      try {
        await navigator.clipboard.writeText(value)
        status.textContent = target === 'key'
          ? '配对密钥已复制，请粘贴到 Android App。'
          : '配对链接已复制，发给手机后 App 粘贴或浏览器打开即可配对。'
      } catch {
        status.textContent = `请复制${target === 'key' ? '配对密钥' : '配对链接'}：${value}`
        status.classList.add('is-key')
      }
    }, error => { status.textContent = String(error) }).finally(() => {
      pair.disabled = !running
      linkPair.disabled = !running
    })
  }
  toggle.addEventListener('click', () => { toggle.disabled = true; void requestJson('/api/mobile-access/control', { method: 'POST', body: JSON.stringify({ running: !running }) }).then(render, error => { status.textContent = String(error) }).finally(() => { toggle.disabled = false }) })
  const formatTime = (ms: unknown): string => typeof ms === 'number' ? new Date(ms).toLocaleString() : ''
  const renderDevices = (data: Record<string, unknown>): void => {
    const devices = Array.isArray(data.devices) ? data.devices as Record<string, unknown>[] : []
    devicePanel.replaceChildren()
    if (devices.length === 0) {
      const empty = element('p', 'dsh-mobile-control__device-empty'); empty.textContent = '暂无配对设备。'
      devicePanel.append(empty)
      return
    }
    for (const device of devices) {
      const row = element('div', 'dsh-mobile-control__device')
      const label = element('span', 'dsh-mobile-control__device-label')
      label.textContent = typeof device.label === 'string' ? device.label : '设备'
      const meta = element('span', 'dsh-mobile-control__device-meta'); meta.textContent = `到期 ${formatTime(device.expiresAt)}`
      const revoke = element('button', 'dsh-mobile-control__device-revoke'); revoke.type = 'button'; revoke.textContent = '撤销'
      const id = typeof device.id === 'string' ? device.id : ''
      revoke.addEventListener('click', () => {
        void requestJson('/api/mobile-access/devices/revoke', { method: 'POST', body: JSON.stringify({ deviceId: id }) })
          .then(loadDevices, error => { status.textContent = String(error) })
      })
      row.append(label, meta, revoke)
      devicePanel.append(row)
    }
  }
  const loadDevices = (): void => {
    void requestJson('/api/mobile-access/devices').then(renderDevices, error => { status.textContent = String(error) })
  }
  manageDevices.addEventListener('click', () => {
    const show = devicePanel.hidden
    devicePanel.hidden = !show
    if (show) loadDevices()
  })
  resetAll.addEventListener('click', () => {
    if (!window.confirm('确定要移除所有配对设备吗？此操作会立即终止已连接设备。')) return
    void requestJson('/api/mobile-access/devices/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      .then(loadDevices, error => { status.textContent = String(error) })
  })
  pair.addEventListener('click', () => { pair.disabled = true; openPairing('key') })
  linkPair.addEventListener('click', () => { linkPair.disabled = true; openPairing('link') })
  close.addEventListener('click', () => { setOpen(false) })
  const dismiss = (event: PointerEvent): void => {
    if (panel.hidden || !(event.target instanceof Node)) return
    if (!panel.contains(event.target) && !document.querySelector('.dsh-mobile-control__trigger')?.contains(event.target)) setOpen(false)
  }
  document.addEventListener('pointerdown', dismiss)
  void requestJson('/api/mobile-access/control').then(render, error => { status.textContent = String(error) })
  return { remove: () => { document.removeEventListener('pointerdown', dismiss); root.remove() }, toggle: () => { setOpen(panel.hidden !== false) } }
}

function mobileRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(path, location.href)
  if (target.origin !== location.origin) throw new TypeError('mobile extension requests must stay on the DSH origin')
  const headers = new Headers(init.headers)
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('dsh_ma_csrf='))?.slice(12)
    if (csrf !== undefined) headers.set('x-dsh-mobile-csrf', csrf)
  }
  return fetch(target, { ...init, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
}

function installCustomAssets(): () => void {
  const style = element('style'); style.dataset.plugin = 'dsh-mobile-custom'; document.head.append(style)
  let cssLoading = false
  const refreshCss = async (): Promise<void> => { if (cssLoading || document.visibilityState === 'hidden') return; cssLoading = true; try { const response = await fetch('/mobile-access/custom.css', { cache: 'no-store', credentials: 'same-origin' }); if (response.ok) { const css = await response.text(); if (style.textContent !== css) style.textContent = css } } finally { cssLoading = false } }
  let activeRoot: HTMLElement | undefined; let disposeActive: (() => void) | undefined; let source = ''; let pending: MobileExtensionMount | undefined
  const previous = window.dshMobile
  window.dshMobile = Object.freeze({ register: (mount: MobileExtensionMount) => { pending = mount } })
  const registeredMount = (): MobileExtensionMount | undefined => pending
  const refreshJs = async (): Promise<void> => { try { const response = await fetch('/mobile-access/custom.js', { cache: 'no-store', credentials: 'same-origin' }); if (!response.ok) return; const next = await response.text(); if (next === source) return; source = next; pending = undefined; const script = element('script'); script.textContent = `${next}\n//# sourceURL=dsh-mobile-custom.js`; document.head.append(script); script.remove(); const mount = registeredMount(); if (mount === undefined) return; const nextRoot = element('div'); nextRoot.dataset.dshMobileExtension = 'true'; document.body.append(nextRoot); const nextDispose = mount({ document, request: mobileRequest, root: nextRoot, window }); disposeActive?.(); activeRoot?.remove(); activeRoot = nextRoot; disposeActive = typeof nextDispose === 'function' ? nextDispose : undefined } catch { /* Preserve the last good customization during reconnects. */ } }
  void refreshCss(); void refreshJs()
  const timer = window.setInterval(() => { void refreshCss(); void refreshJs() }, 1_000)
  return () => { clearInterval(timer); disposeActive?.(); activeRoot?.remove(); style.remove(); if (previous === undefined) delete window.dshMobile; else window.dshMobile = previous }
}

const CONTROL_STYLES = `
.dsh-mobile-control{position:fixed;z-index:1000;left:16px;bottom:64px;font:14px/1.45 system-ui;color:var(--dsw-alias-label-primary,#16181d)}
.dsh-mobile-control__panel{box-sizing:border-box;width:min(328px,calc(100vw - 32px));padding:16px;border:1px solid var(--dsw-alias-border-subtle,#e1e5eb);border-radius:18px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 18px 50px rgb(15 23 42 / 18%)}
.dsh-mobile-control__header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}.dsh-mobile-control__panel h2{margin:0;font-size:17px;line-height:24px}.dsh-mobile-control__close{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;border:0;border-radius:10px;background:transparent;color:inherit;font-size:24px;line-height:1;cursor:pointer}.dsh-mobile-control__close:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}
.dsh-mobile-control__access{display:flex;align-items:baseline;gap:6px;min-width:0;margin:0 0 12px}.dsh-mobile-control__access[hidden]{display:none}.dsh-mobile-control__access-label{flex:none;color:var(--dsw-alias-label-secondary,#606873);white-space:nowrap}.dsh-mobile-control__access-label::after{content:"："}.dsh-mobile-control__access-link{min-width:0;overflow:hidden;color:#2563eb;text-decoration:none;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__access-link:hover{text-decoration:underline}.dsh-mobile-control__qr{display:flex;justify-content:center;margin:0 0 12px}.dsh-mobile-control__qr[hidden]{display:none}.dsh-mobile-control__qr img{border-radius:12px;background:#fff;padding:8px}
.dsh-mobile-control__status{margin:0 0 14px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#606873)}.dsh-mobile-control__status::before{display:inline-block;width:8px;height:8px;margin-right:7px;border-radius:50%;background:#98a1ad;content:""}.dsh-mobile-control__status.is-running::before{background:#16a36a}.dsh-mobile-control__status.is-key{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all}
.dsh-mobile-control__actions{display:flex;flex-wrap:nowrap;gap:6px}.dsh-mobile-control__actions button{flex:1 1 0;min-width:0;min-height:40px;padding:8px 4px;border-radius:10px;font:12px/1.2 system-ui;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsh-mobile-control__secondary{border:1px solid var(--dsw-alias-border-normal,#cfd5dd);background:transparent;color:inherit}.dsh-mobile-control__primary{border:1px solid #2563eb;background:#2563eb;color:#fff}.dsh-mobile-control__actions button:disabled{cursor:not-allowed;opacity:.45}
.dsh-mobile-control__trigger{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:calc(100% + 8px);height:34px;margin:4px -4px;padding:6px 2px 6px 10px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary,#16181d);font:14px/22px system-ui;cursor:pointer}.dsh-mobile-control__trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}.dsh-mobile-control__trigger.is-rail{width:36px;height:36px;margin:8px 0 10px;padding:0;justify-content:center;border-radius:50%}.dsh-mobile-control__trigger-icon{position:relative;box-sizing:border-box;flex:none;width:14px;height:19px;border:1.7px solid currentColor;border-radius:3px}.dsh-mobile-control__trigger-icon::after{position:absolute;right:4px;bottom:2px;width:4px;height:1.5px;border-radius:2px;background:currentColor;content:""}.dsh-mobile-control__trigger-label{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dsh-mobile-control__manage-row{display:flex;justify-content:space-between;gap:8px;margin-top:10px}.dsh-mobile-control__manage{flex:1 1 0;min-width:0;min-height:34px;padding:6px 8px;border:1px solid var(--dsw-alias-border-normal,#cfd5dd);border-radius:10px;background:transparent;color:inherit;font:12px/1.3 system-ui;cursor:pointer}.dsh-mobile-control__devices{margin-top:10px;border:1px solid var(--dsw-alias-border-subtle,#e1e5eb);border-radius:10px;padding:8px;max-height:220px;overflow-y:auto}.dsh-mobile-control__device-empty{color:var(--dsw-alias-label-secondary,#606873);font-size:12px;margin:0}.dsh-mobile-control__device{display:flex;align-items:center;gap:8px;padding:6px 2px}.dsh-mobile-control__device + .dsh-mobile-control__device{border-top:1px solid var(--dsw-alias-border-subtle,#e1e5eb)}.dsh-mobile-control__device-label{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.dsh-mobile-control__device-meta{flex:none;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;white-space:nowrap}.dsh-mobile-control__device-revoke{flex:none;min-height:28px;padding:4px 8px;border:1px solid #dc2626;border-radius:8px;background:transparent;color:#dc2626;font:12px/1.2 system-ui;cursor:pointer}
`

/** Mount the desktop control or mobile feature enhancements. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const loopback = isLoopbackHost(location.hostname) && !new URLSearchParams(location.search).has('dsh-mobile-preview')
    const style = element('style'); style.dataset.plugin = 'dsh-mobile'; style.textContent = loopback
      ? CONTROL_STYLES
      : NATIVE_MOBILE_STYLES
    document.head.append(style)
    if (!loopback) {
      const removeCustom = installCustomAssets()
      const removeSurface = installNativeMobileSurface()
      return () => { removeCustom(); removeSurface(); style.remove() }
    }
    const control = installControl()
    const disposeSlot = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-mobile' }, ({ wide }) => createElement('button', {
      'aria-expanded': false,
      'aria-label': '移动访问',
      className: `dsh-mobile-control__trigger${wide ? '' : ' is-rail'}`,
      type: 'button',
      title: '移动访问',
      onClick: control.toggle,
    }, createElement('span', { 'aria-hidden': true, className: 'dsh-mobile-control__trigger-icon' }), wide ? createElement('span', { className: 'dsh-mobile-control__trigger-label' }, '移动访问') : undefined)))
    return () => { disposeSlot(); control.remove(); style.remove() }
  }, 'dsh-mobile: stock mobile adaptation and local control')
}

/** Client services required by the mobile adaptation. */
export const inject: readonly string[] = ['slots']
