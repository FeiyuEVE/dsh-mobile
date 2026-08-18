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
type MobileSurfacePlacement = 'page' | 'sidebar-action' | 'header-action' | 'composer-dock' | 'settings-section' | 'overlay'
interface MobileSurface {
  readonly id: string
  readonly placement: MobileSurfacePlacement
  readonly label: string
  mount(container: HTMLElement): void | (() => void)
}
interface MobileClientApi {
  readonly host: {
    invoke(action: string, input: unknown): Promise<unknown>
    fetch(path: string, init?: RequestInit): Promise<Response>
  }
  readonly ui: {
    registerSurface(surface: MobileSurface): () => void
    open(surfaceId: string): void
    close(surfaceId: string): void
    toast(message: string): void
  }
  readonly native: {
    capabilities(): Promise<readonly string[]>
    invoke(action: string, input?: unknown): Promise<unknown>
  }
  readonly signal: AbortSignal
  readonly document: Document
  readonly window: Window
}
interface MobileClientDefinition {
  readonly apiVersion: 1
  readonly id: string
  activate(api: MobileClientApi): void | (() => void) | Promise<void | (() => void)>
}

declare global {
  interface Window {
    dshMobile?: {
      register(mount: MobileExtensionMount): void
      define(definition: MobileClientDefinition): void
    }
    __DSH_MOBILE_FRONTEND__?: 'dedicated'
    __DSH_MOBILE_NATIVE__?: {
      capabilities(): Promise<readonly string[]> | readonly string[]
      invoke(action: string, input?: unknown): Promise<unknown>
    }
  }
}

const queuedDefinitions: MobileClientDefinition[] = []
let queuedLegacyMount: MobileExtensionMount | undefined
if (typeof window !== 'undefined' && window.dshMobile === undefined) {
  window.dshMobile = {
    register: mount => { queuedLegacyMount = mount },
    define: definition => { queuedDefinitions.push(definition) },
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
  const extensionStatus = element('p', 'dsh-mobile-control__extensions'); extensionStatus.hidden = true
  const actions = element('div', 'dsh-mobile-control__actions')
  const toggle = element('button', 'dsh-mobile-control__secondary'); toggle.type = 'button'
  const pair = element('button', 'dsh-mobile-control__primary'); pair.type = 'button'; pair.textContent = '生成并复制密钥'
  const linkPair = element('button', 'dsh-mobile-control__secondary'); linkPair.type = 'button'; linkPair.textContent = '复制配对链接'
  const manageRow = element('div', 'dsh-mobile-control__manage-row')
  const manageDevices = element('button', 'dsh-mobile-control__manage'); manageDevices.type = 'button'; manageDevices.textContent = '管理配对设备'
  const resetAll = element('button', 'dsh-mobile-control__manage'); resetAll.type = 'button'; resetAll.textContent = '清除所有设备'
  manageRow.append(manageDevices, resetAll)
  const devicePanel = element('div', 'dsh-mobile-control__devices'); devicePanel.hidden = true
  header.append(title, close); actions.append(toggle, pair, linkPair); panel.append(header, access, qrBox, status, extensionStatus, actions, manageRow, devicePanel); root.append(panel); document.body.append(root)
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
    const extensionData = data.extensions
    if (extensionData !== null && typeof extensionData === 'object') {
      const loaded = typeof (extensionData as { loaded?: unknown }).loaded === 'number' ? (extensionData as { loaded: number }).loaded : 0
      const failed = typeof (extensionData as { failed?: unknown }).failed === 'number' ? (extensionData as { failed: number }).failed : 0
      extensionStatus.hidden = false
      extensionStatus.textContent = failed === 0 ? `扩展：${String(loaded)} 个已加载` : `扩展：${String(loaded)} 个已加载，${String(failed)} 个加载失败`
    } else extensionStatus.hidden = true
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
  const legacyStyle = element('style'); legacyStyle.dataset.plugin = 'dsh-mobile-custom'; document.head.append(legacyStyle)
  const previous = window.dshMobile
  let legacyMount: MobileExtensionMount | undefined = queuedLegacyMount
  let legacySource = ''
  let legacyRoot: HTMLElement | undefined
  let legacyDispose: (() => void) | undefined
  const definitions = new Map<string, MobileClientDefinition>()
  const active = new Map<string, { readonly controller: AbortController; readonly dispose: () => void; readonly surfaces: Map<string, { readonly dispose: () => void; readonly container: HTMLElement }> }>()
  const styleNodes = new Map<string, HTMLStyleElement>()
  const styleEtags = new Map<string, string>()
  const scriptDigests = new Map<string, string>()
  let manifestEtag = ''
  let expectedDefinitionId: string | undefined
  const SURFACE_HOST_STYLES: Readonly<Record<string, string>> = {
    'sidebar-action': 'position:fixed;z-index:1100;top:calc(env(safe-area-inset-top) + 8px);left:8px;display:flex;flex-direction:column;gap:6px;pointer-events:none',
    'header-action': 'position:fixed;z-index:1100;top:calc(env(safe-area-inset-top) + 8px);right:8px;display:flex;flex-direction:column;gap:6px;pointer-events:none',
    'composer-dock': 'position:fixed;z-index:1100;bottom:calc(env(safe-area-inset-bottom) + 8px);left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;pointer-events:none',
    'settings-section': 'position:fixed;z-index:1100;inset:auto 8px calc(env(safe-area-inset-bottom) + 72px) 8px;max-height:40vh;overflow:auto;pointer-events:none',
  }
  const surfaceHost = (placement: string): HTMLElement | undefined => {
    const existing = document.querySelector<HTMLElement>(`[data-dsh-mobile-surface-host="${placement}"]`)
    if (existing !== null) return existing
    const style = SURFACE_HOST_STYLES[placement]
    if (style === undefined) return undefined
    const host = element('div'); host.dataset.dshMobileSurfaceHost = placement; host.style.cssText = style
    document.body.append(host); return host
  }
  const shellLayer = (): HTMLElement => {
    const existing = document.querySelector<HTMLElement>('[data-dsh-mobile-extension-layer]')
    if (existing !== null) return existing
    const layer = element('div'); layer.dataset.dshMobileExtensionLayer = 'true'; layer.style.cssText = 'position:fixed;inset:0;z-index:1200;pointer-events:none;overflow:hidden'
    document.body.append(layer); return layer
  }
  const toast = (message: string): void => {
    const node = element('div'); node.textContent = message; node.style.cssText = 'position:absolute;top:16px;left:50%;transform:translateX(-50%);padding:9px 14px;border-radius:999px;background:#1f2937;color:white;font:14px system-ui;pointer-events:auto;box-shadow:0 8px 24px #0003'
    shellLayer().append(node); window.setTimeout(() => node.remove(), 2600)
  }
  const materializeNativeFile = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || !('base64' in value) || !('name' in value)) return value
    const candidate = value as { base64?: unknown; name?: unknown; type?: unknown }
    if (typeof candidate.base64 !== 'string' || typeof candidate.name !== 'string') return value
    try {
      const encoded = atob(candidate.base64)
      const bytes = Uint8Array.from(encoded, character => character.charCodeAt(0))
      return new File([bytes], candidate.name, { type: typeof candidate.type === 'string' ? candidate.type : 'application/octet-stream' })
    } catch {
      return value
    }
  }
  const invokeNative = async (action: string, input?: unknown): Promise<unknown> => {
    const bridge = window.__DSH_MOBILE_NATIVE__
    if (bridge !== undefined) return materializeNativeFile(await bridge.invoke(action, input))
    if (action === 'share' && typeof navigator.share === 'function') { await navigator.share((input ?? {}) as ShareData); return { ok: true } }
    if (action === 'clipboard.read' && navigator.clipboard !== undefined) return { text: await navigator.clipboard.readText() }
    if (action === 'clipboard.write' && navigator.clipboard !== undefined) { await navigator.clipboard.writeText(typeof input === 'object' && input !== null && 'text' in input ? String((input as { text: unknown }).text) : ''); return { ok: true } }
    if (action === 'files.pick' || action === 'camera.capture') {
      const inputElement = element('input'); inputElement.type = 'file'; inputElement.accept = action === 'camera.capture' ? 'image/*' : '*/*'; if (action === 'camera.capture') inputElement.capture = 'environment';
      return new Promise<File | undefined>(resolve => { inputElement.onchange = () => resolve(inputElement.files?.[0]); inputElement.click() })
    }
    throw new Error('native capability is unavailable')
  }
  const makeApi = (id: string, controller: AbortController): MobileClientApi => {
    const surfaces = active.get(id)?.surfaces ?? new Map()
    const mountSurface = (surface: MobileSurface): (() => void) => {
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(surface.id) || surface.label.length > 120) throw new Error('invalid mobile surface')
      const container = element('section'); container.dataset.dshMobileSurface = surface.id; container.hidden = surface.placement === 'page' || surface.placement === 'overlay'; container.style.cssText = surface.placement === 'page' || surface.placement === 'overlay' ? 'position:absolute;inset:0;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fff);padding:16px;pointer-events:auto' : 'pointer-events:auto'
      const host = surface.placement === 'page' || surface.placement === 'overlay' ? shellLayer() : surfaceHost(surface.placement) ?? shellLayer()
      host.append(container)
      const mounted = surface.mount(container)
      const dispose = (): void => { if (typeof mounted === 'function') mounted(); container.remove() }
      surfaces.set(surface.id, { dispose, container });
      return () => { if (surfaces.get(surface.id)?.dispose === dispose) surfaces.delete(surface.id); dispose() }
    }
    return {
      host: {
        invoke: (action: string, input: unknown) => mobileRequest(`/mobile-access/extensions/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`, { method: 'POST', body: JSON.stringify(input ?? {}) }).then(async response => { const value = await response.json() as unknown; if (!response.ok) throw new Error(typeof value === 'object' && value !== null && 'error' in value ? String((value as { error: unknown }).error) : `HTTP ${String(response.status)}`); return value }),
        fetch: (path: string, init?: RequestInit) => {
          if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')
            || path.split('/').some(part => part === '..' || part === '.')) throw new TypeError('extension routes must be relative')
          return mobileRequest(`/mobile-access/extensions/${encodeURIComponent(id)}/routes${path}`, init)
        },
      },
      ui: { registerSurface: mountSurface, open: id => { const entry = surfaces.get(id); if (entry !== undefined) entry.container.hidden = false }, close: id => { const entry = surfaces.get(id); if (entry !== undefined) entry.container.hidden = true }, toast },
      native: { capabilities: async () => { const bridge = window.__DSH_MOBILE_NATIVE__; return bridge === undefined ? ['files.pick', 'camera.capture', 'share', 'clipboard.read', 'clipboard.write'] : bridge.capabilities() }, invoke: invokeNative },
      signal: controller.signal, document, window,
    }
  }
  const activateDefinition = async (definition: MobileClientDefinition): Promise<void> => {
    const previousActive = active.get(definition.id)
    const controller = new AbortController()
    const surfaces = new Map<string, { readonly dispose: () => void; readonly container: HTMLElement }>()
    active.set(definition.id, { controller, surfaces, dispose: () => { controller.abort(); for (const surface of surfaces.values()) surface.dispose(); surfaces.clear() } })
    try {
      const cleanup = await definition.activate(makeApi(definition.id, controller))
      const current = active.get(definition.id)
      if (current === undefined || current.controller !== controller) { if (typeof cleanup === 'function') cleanup(); return }
      const oldDispose = current.dispose
      active.set(definition.id, { ...current, dispose: () => { if (typeof cleanup === 'function') cleanup(); oldDispose() } })
      previousActive?.dispose()
    } catch {
      active.get(definition.id)?.dispose(); active.delete(definition.id); if (previousActive !== undefined) active.set(definition.id, previousActive)
    }
  }
  const define = (definition: MobileClientDefinition): void => {
    if (definition.apiVersion !== 1 || !/^[a-z][a-z0-9-]{0,63}$/u.test(definition.id) || typeof definition.activate !== 'function') return
    if (expectedDefinitionId !== undefined && definition.id !== expectedDefinitionId) return
    definitions.set(definition.id, definition)
    if (started) void activateDefinition(definition)
  }
  let started = false
  window.dshMobile = Object.freeze({ register: mount => { legacyMount = mount }, define })
  for (const definition of queuedDefinitions.splice(0)) define(definition)
  let legacyJsEtag = ''
  let legacyJsModified = ''
  const refreshLegacy = async (): Promise<void> => {
    try {
      const headers: Record<string, string> = {}
      if (legacyJsEtag !== '') headers['if-none-match'] = legacyJsEtag
      if (legacyJsModified !== '') headers['if-modified-since'] = legacyJsModified
      const response = await fetch('/mobile-access/custom.js', { credentials: 'same-origin', cache: 'no-store', headers })
      if (response.status === 304) return
      if (!response.ok) return
      legacyJsEtag = response.headers.get('etag') ?? ''
      legacyJsModified = response.headers.get('last-modified') ?? ''
      const next = await response.text(); if (next === legacySource) return; legacySource = next; legacyMount = undefined
      const script = element('script'); script.textContent = `${next}\n//# sourceURL=dsh-mobile-custom.js`; document.head.append(script); script.remove()
      const mount = legacyMount as MobileExtensionMount | undefined
      if (mount === undefined) return
      const nextRoot = element('div'); nextRoot.dataset.dshMobileExtension = 'true'; document.body.append(nextRoot)
      const nextDispose = mount({ document, request: mobileRequest, root: nextRoot, window })
      legacyDispose?.(); legacyRoot?.remove(); legacyRoot = nextRoot; legacyDispose = typeof nextDispose === 'function' ? nextDispose : undefined
    } catch { /* Preserve the last good customization during reconnects. */ }
  }
  const refreshExtensions = async (): Promise<void> => {
    try {
      const headers: Record<string, string> = {}
      if (manifestEtag !== '') headers['if-none-match'] = manifestEtag
      const response = await fetch('/mobile-access/extensions/manifest', { credentials: 'same-origin', cache: 'no-store', headers })
      if (response.status === 304) return
      if (!response.ok) return
      manifestEtag = response.headers.get('etag') ?? ''
      const payload = await response.json() as { extensions?: unknown }
      const entries = Array.isArray(payload.extensions) ? payload.extensions as Record<string, unknown>[] : []
      const seen = new Set<string>()
      for (const entry of entries) {
        if (typeof entry.id !== 'string') continue
        seen.add(entry.id)
        const cssUrl = typeof entry.styleUrl === 'string' ? entry.styleUrl : undefined
        if (cssUrl !== undefined) {
          const cssHeaders: Record<string, string> = {}
          const storedEtag = styleEtags.get(entry.id)
          if (storedEtag !== undefined) cssHeaders['if-none-match'] = storedEtag
          const cssResponse = await fetch(cssUrl, { credentials: 'same-origin', cache: 'no-store', headers: cssHeaders })
          if (cssResponse.status === 304) { /* unchanged */ }
          else if (cssResponse.ok) {
            const nextEtag = cssResponse.headers.get('etag'); if (nextEtag !== null && nextEtag !== '') styleEtags.set(entry.id, nextEtag)
            const css = await cssResponse.text(); const oldStyle = styleNodes.get(entry.id)
            if (oldStyle?.textContent !== css) {
              const node = element('style'); node.dataset.dshMobileExtensionStyle = entry.id; node.textContent = css; document.head.append(node); styleNodes.set(entry.id, node); oldStyle?.remove()
            }
          } else continue
        }
        const scriptUrl = typeof entry.scriptUrl === 'string' ? entry.scriptUrl : undefined
        if (scriptUrl !== undefined) {
          const scriptHeaders: Record<string, string> = {}
          const storedDigest = scriptDigests.get(entry.id)
          if (storedDigest !== undefined) scriptHeaders['if-none-match'] = storedDigest
          const scriptResponse = await fetch(scriptUrl, { credentials: 'same-origin', cache: 'no-store', headers: scriptHeaders })
          if (scriptResponse.status === 304) { /* unchanged */ }
          else if (scriptResponse.ok) {
            const source = await scriptResponse.text(); const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)); const key = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
            if (scriptDigests.get(entry.id) !== key) {
              scriptDigests.set(entry.id, key)
              expectedDefinitionId = entry.id
              try { const script = element('script'); script.textContent = `${source}\n//# sourceURL=dsh-mobile-extension-${entry.id}.js`; document.head.append(script); script.remove() }
              finally { expectedDefinitionId = undefined }
            }
          } else continue
        }
        const definition = definitions.get(entry.id); if (definition !== undefined && !active.has(entry.id)) await activateDefinition(definition)
      }
      for (const [id, current] of active) if (!seen.has(id) && !definitions.has(id) && id !== 'legacy-custom') { current.dispose(); active.delete(id); styleNodes.get(id)?.remove(); styleNodes.delete(id); styleEtags.delete(id); scriptDigests.delete(id) }
    } catch { /* A temporary reconnect failure must not tear down the last good UI. */ }
  }
  started = true
  for (const definition of definitions.values()) void activateDefinition(definition)
  void refreshLegacy(); void refreshExtensions(); void refreshCssLegacy(legacyStyle)
  const timer = window.setInterval(() => { void refreshLegacy(); void refreshExtensions(); void refreshCssLegacy(legacyStyle) }, 3_000)
  return () => { clearInterval(timer); started = false; legacyDispose?.(); legacyRoot?.remove(); legacyStyle.remove(); for (const current of active.values()) current.dispose(); for (const node of styleNodes.values()) node.remove(); const layer = document.querySelector('[data-dsh-mobile-extension-layer]'); layer?.remove(); for (const host of document.querySelectorAll('[data-dsh-mobile-surface-host]')) host.remove(); if (previous === undefined) delete window.dshMobile; else window.dshMobile = previous }
}

let cssEtag = ''
let cssModified = ''
async function refreshCssLegacy(style: HTMLStyleElement): Promise<void> {
  try {
    const headers: Record<string, string> = {}
    if (cssEtag !== '') headers['if-none-match'] = cssEtag
    if (cssModified !== '') headers['if-modified-since'] = cssModified
    const response = await fetch('/mobile-access/custom.css', { credentials: 'same-origin', cache: 'no-store', headers })
    if (response.status === 304) return
    if (response.ok) {
      cssEtag = response.headers.get('etag') ?? ''
      cssModified = response.headers.get('last-modified') ?? ''
      style.textContent = await response.text()
    }
  } catch { /* Preserve the last good style during reconnects. */ }
}

const CONTROL_STYLES = `
.dsh-mobile-control{position:fixed;z-index:1000;left:16px;bottom:64px;font:14px/1.45 system-ui;color:var(--dsw-alias-label-primary,#16181d)}
.dsh-mobile-control__panel{box-sizing:border-box;width:min(328px,calc(100vw - 32px));padding:16px;border:1px solid var(--dsw-alias-border-subtle,#e1e5eb);border-radius:18px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 18px 50px rgb(15 23 42 / 18%)}
.dsh-mobile-control__header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}.dsh-mobile-control__panel h2{margin:0;font-size:17px;line-height:24px}.dsh-mobile-control__close{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;border:0;border-radius:10px;background:transparent;color:inherit;font-size:24px;line-height:1;cursor:pointer}.dsh-mobile-control__close:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}
.dsh-mobile-control__access{display:flex;align-items:baseline;gap:6px;min-width:0;margin:0 0 12px}.dsh-mobile-control__access[hidden]{display:none}.dsh-mobile-control__access-label{flex:none;color:var(--dsw-alias-label-secondary,#606873);white-space:nowrap}.dsh-mobile-control__access-label::after{content:"："}.dsh-mobile-control__access-link{min-width:0;overflow:hidden;color:#2563eb;text-decoration:none;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__access-link:hover{text-decoration:underline}.dsh-mobile-control__qr{display:flex;justify-content:center;margin:0 0 12px}.dsh-mobile-control__qr[hidden]{display:none}.dsh-mobile-control__qr img{border-radius:12px;background:#fff;padding:8px}
.dsh-mobile-control__status{margin:0 0 14px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#606873)}.dsh-mobile-control__status::before{display:inline-block;width:8px;height:8px;margin-right:7px;border-radius:50%;background:#98a1ad;content:""}.dsh-mobile-control__status.is-running::before{background:#16a36a}.dsh-mobile-control__status.is-key{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all}
.dsh-mobile-control__extensions{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#606873);font-size:12px}
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
