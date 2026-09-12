/**
 * dsh-android-edapp「移动适配协议 v1」的**外壳侧**（adapter shell）。
 *
 * ## 协议两侧
 * 插件（如 dsh-memory-evolve）只在 `./client` 的导出面上声明：
 *
 *     export const dshMobile = { css: '<移动端 CSS 片段>', enhance?: () => () => void }
 *
 * 外壳负责三件事，插件自己一行样式都不往 `<head>` 里塞：
 * 1. 移动模式激活时给 `<html>` 挂 `data-dsh-mobile`（插件选择器一律以此前缀限定）；
 * 2. 把 `css` 原样包进 `@media (max-width: 767px) {}` 注入页面（因此插件不写 @media）；
 * 3. `enhance` 存在时在移动模式激活时调用一次，退出时调用它返回的 dispose。
 *
 * ## 为什么需要这一层
 * dsh-mobile 自己那套 `window.dshMobile = { register, define }` 是给「手机端自定义
 * 脚本」用的，与协议同名的 `dshMobile` **同名不同实**：它既不挂 `data-dsh-mobile`，
 * 也不扫描插件导出面。两套协议各说各话的结果是插件的移动端 CSS 原样躺在 bundle 里
 * 一行都不生效（页面能开、bundle 能取、--dump-config 全绿），手机上看到的是按桌面
 * 假设排版的插件面板。本模块把协议的外壳侧补齐，对所有遵守该协议的插件一次性生效。
 *
 * ## 发现时机
 * 导出面只能在模块**物化**之后读到，而客户端模块是懒加载的（打开某个 Tab 才物化对应
 * 插件），所以这里按固定间隔重扫 `loadCache`（模块物化记录表），新出现的声明即时注入；
 * 记录对象换新（HMR invalidate 后重新物化）则先撤旧样式再按新声明重建。
 */

/** 协议规定的媒体门槛：注入的插件 CSS 与 `data-dsh-mobile` 属性都以它为准。 */
export const MOBILE_ADAPTER_MEDIA_QUERY = '(max-width: 767px)'

/**
 * 重扫间隔（毫秒）。协议没有「模块已物化」事件可用，只能在物化记录表上轮询；
 * 一次扫描是几十次 Map 迭代，代价可忽略，而懒加载插件可能在任意时刻出现。
 */
export const MOBILE_ADAPTER_SCAN_INTERVAL_MS = 1000

/**
 * 注入样式的属主标记。客户端模块系统物化任何模块时会把页面上所有**未标记**的
 * `<style>` 收编给该模块（`claimStyles`），被收编的样式会在那个模块 invalidate 时
 * 一起移除，所以协议注入的样式必须自带 `data-plugin`。
 */
const ADAPTER_STYLE_OWNER = 'dsh-mobile'

/** 移动模式开关：`data-dsh-mobile` 属性名。 */
export const MOBILE_ADAPTER_ATTRIBUTE = 'data-dsh-mobile'

/** One plugin's normalized protocol declaration. */
export interface MobileAdapterDeclaration {
  /** Declaring module id (npm package name). */
  readonly id: string
  /** Mobile CSS fragment the plugin declared, or null when it declared none. */
  readonly css: string | null
  /**
   * DOM enhancer to run once per activation, or null. The declaration's own object
   * is kept as the receiver, and a returned function is used as its disposer.
   */
  readonly enhance: (() => void | (() => void)) | null
}

/** One module's materialized exports, as far as the adapter shell reads them. */
export interface MobileAdapterModuleRecord {
  readonly exports?: unknown
}

/** The materialized-module registry (`ctx.modules.loadCache`). */
export interface MobileAdapterModuleSource {
  readonly loadCache?: ReadonlyMap<string, MobileAdapterModuleRecord> | undefined
}

/**
 * Read one module's export surface as a protocol declaration.
 * @param id - module id the exports belong to.
 * @param exports - the module's materialized exports.
 * @returns the normalized declaration, or null when this module declares nothing.
 */
export function readMobileAdapterDeclaration(id: string, exports: unknown): MobileAdapterDeclaration | null {
  if (typeof exports !== 'object' || exports === null) return null
  const declared = (exports as { readonly dshMobile?: unknown }).dshMobile
  if (typeof declared !== 'object' || declared === null) return null
  const surface = declared as { readonly css?: unknown; readonly enhance?: unknown }
  const css = typeof surface.css === 'string' && surface.css.trim() !== '' ? surface.css : null
  const declaredEnhance = surface.enhance
  const enhance = typeof declaredEnhance === 'function'
    ? (): void | (() => void) => {
      const dispose = (declaredEnhance as (this: unknown) => unknown).call(declared)
      return typeof dispose === 'function' ? dispose as () => void : undefined
    }
    : null
  return css === null && enhance === null ? null : { id, css, enhance }
}

/** Wrap a plugin's media-less fragment in the protocol's viewport gate. */
export function wrapMobileAdapterCss(css: string): string {
  return `@media ${MOBILE_ADAPTER_MEDIA_QUERY} {\n${css}\n}`
}

interface AdapterEntry {
  readonly id: string
  readonly record: MobileAdapterModuleRecord
  readonly css: string | null
  readonly enhance: (() => void | (() => void)) | null
  style: HTMLStyleElement | null
  dispose: (() => void) | null
  /** Whether `enhance` ran for the current activation (a void enhancer has no dispose). */
  enhanced: boolean
}

/**
 * Install the protocol's shell side: mount `data-dsh-mobile`, inject every declared
 * mobile CSS fragment, and run every declared enhancer while the viewport is mobile.
 *
 * Every side effect belongs to the returned disposer: the attribute, the injected
 * styles, the enhancer disposers, the viewport listener, and the rescan timer.
 * @param resolveModules - reads the client module registry (`ctx.modules`). It is a
 *   resolver rather than a value because the registry can still be absent when the
 *   client half applies; the protocol stays inert until a scan finds it.
 * @returns the disposer removing everything this call installed.
 */
export function installMobileAdapterShell(
  resolveModules: () => MobileAdapterModuleSource | null | undefined,
): () => void {
  const root = document.documentElement
  const previousAttribute = root.getAttribute(MOBILE_ADAPTER_ATTRIBUTE)
  const entries = new Map<string, AdapterEntry>()
  const viewport = typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_ADAPTER_MEDIA_QUERY) : null
  let active = false
  let disposed = false

  const injectStyle = (entry: AdapterEntry): void => {
    if (entry.css === null || entry.style !== null) return
    const style = document.createElement('style')
    style.dataset.plugin = ADAPTER_STYLE_OWNER
    style.dataset.dshMobileAdapter = entry.id
    style.textContent = wrapMobileAdapterCss(entry.css)
    document.head.append(style)
    entry.style = style
  }

  const runEnhancer = (entry: AdapterEntry): void => {
    if (entry.enhance === null || entry.enhanced) return
    // A plugin's enhancer must never take the shell (and every later plugin) down.
    try {
      const dispose = entry.enhance()
      entry.enhanced = true
      entry.dispose = typeof dispose === 'function' ? dispose : null
    } catch { entry.dispose = null }
  }

  const retire = (entry: AdapterEntry): void => {
    try { entry.dispose?.() } catch { /* the plugin's own teardown is its business */ }
    entry.dispose = null
    entry.enhanced = false
    entry.style?.remove()
    entry.style = null
  }

  const isMobileViewport = (): boolean => viewport === null || viewport.matches

  const activate = (): void => {
    if (disposed || active) return
    active = true
    root.setAttribute(MOBILE_ADAPTER_ATTRIBUTE, '')
    for (const entry of entries.values()) runEnhancer(entry)
  }

  const deactivate = (): void => {
    if (!active) return
    active = false
    if (previousAttribute === null) root.removeAttribute(MOBILE_ADAPTER_ATTRIBUTE)
    else root.setAttribute(MOBILE_ADAPTER_ATTRIBUTE, previousAttribute)
    for (const entry of entries.values()) retire(entry)
  }

  const scan = (): void => {
    if (disposed) return
    const cache = resolveModules()?.loadCache
    if (cache === undefined) return
    for (const [id, record] of cache) {
      if (record === null || typeof record !== 'object') continue
      const entry = entries.get(id)
      // Same record: already handled (declaration read, styles and enhancer in place).
      if (entry !== undefined && entry.record === record) continue
      if (entry !== undefined) retire(entry)
      const declaration = readMobileAdapterDeclaration(id, record.exports)
      const next: AdapterEntry = {
        id,
        record,
        css: declaration?.css ?? null,
        enhance: declaration?.enhance ?? null,
        style: null,
        dispose: null,
        enhanced: false,
      }
      entries.set(id, next)
      // The fragment itself carries no @media: it is inert on a desktop viewport
      // once wrapped, so it is injected regardless of the current mode.
      injectStyle(next)
      if (active) runEnhancer(next)
    }
    // A record dropped by HMR invalidation owns nothing anymore: drop its style too,
    // and let the next materialization re-add it through the branch above.
    for (const [id, entry] of [...entries]) {
      if (cache.has(id)) continue
      retire(entry)
      entries.delete(id)
    }
  }

  const syncViewport = (): void => {
    if (isMobileViewport()) activate()
    else deactivate()
  }

  scan()
  syncViewport()
  const timer = window.setInterval(scan, MOBILE_ADAPTER_SCAN_INTERVAL_MS)
  if (viewport !== null) {
    if (typeof viewport.addEventListener === 'function') viewport.addEventListener('change', syncViewport)
    else viewport.addListener(syncViewport)
  }

  return () => {
    disposed = true
    window.clearInterval(timer)
    if (viewport !== null) {
      if (typeof viewport.removeEventListener === 'function') viewport.removeEventListener('change', syncViewport)
      else viewport.removeListener(syncViewport)
    }
    deactivate()
    for (const entry of entries.values()) retire(entry)
    entries.clear()
  }
}
