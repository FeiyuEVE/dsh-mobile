import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { createSocket, type Socket as DatagramSocket } from 'node:dgram'
import { readFile, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { extname } from 'node:path'
import {
  createServer as createHttpServer,
  request as requestHttp,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer, type ServerOptions } from 'node:https'
import { connect, isIP, type AddressInfo, type Socket } from 'node:net'
import { Transform, type TransformCallback } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createGzip, gzip } from 'node:zlib'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import Bonjour from 'bonjour-service'
import { AccessError, type SessionAuthorization } from './access.js'
import type { AccountTokenSummary } from './account.js'
import { AccountController } from './account.js'
import type { ResolvedGatewayConfig } from './config.js'
import { SERVICE_WORKER_PATH, SERVICE_WORKER_SOURCE, injectServiceWorkerRegistration } from './sw-cache.js'
import {
  AUTH_PREFIX,
  assertExternalTrust,
  assertLocalAdminTrust,
  cookie,
  CSRF_COOKIE,
  CSRF_HEADER,
  HttpError,
  LOCAL_ADMIN_PREFIX,
  parseCookies,
  parseRequestTarget,
  readJsonObject,
  sendFailure,
  sendJson,
  SESSION_COOKIE,
  setSecurityHeaders,
  WS_PATHS,
} from './http-security.js'
import {
  DSH_MOBILE_VERSION,
  MINIMUM_ANDROID_APP_VERSION,
  MOBILE_METADATA_VERSION,
} from './version.js'
import { addressAllowed, isLoopbackAddress, type ParsedCidr, RequestTrustPolicy } from './network.js'
import { listComputerImages, readComputerImage } from './computer-images.js'
import {
  EXTENSION_LIMITS,
  MobileExtensionError,
  type MobileAccessService,
  type MobileRouteRequest,
  type MobileRouteResponse,
} from './extensions.js'

type GatewayServer = HttpServer | HttpsServer

interface ActiveRequest {
  readonly sessionKey: string
  readonly deviceId: string
  readonly expiresAt: number
  readonly abort: () => void
  readonly timer: NodeJS.Timeout
}

interface ActiveWebSocket {
  readonly sessionKey: string
  readonly deviceId: string
  readonly client: Socket
  readonly upstream: Socket
  readonly timer: NodeJS.Timeout
}

const MAX_CONTROL_BODY_BYTES = 16 * 1024
const MAX_HEADER_BYTES = 16 * 1024
const MOBILE_HISTORY_PAGE_MESSAGES = 10
const SESSION_HISTORY_PATH = '/api/session.history'

/** 日志查询的**进程内**共享键（GET /api/mobile-logs）：网关反代到 3080 时注入
 *  请求头 `x-log-query`，3080 侧插件路由比对同一值。两半在同一进程里，所以键在
 *  启动时随机生成——不落盘、不进客户端、无需轮换（0.3.41 起取代原先写在源码里的
 *  `LOG_QUERY_TOKEN` 静态常量与 App 内置的同一份拷贝）。
 *  客户端进这条路由的凭据是**账号会话**（Bearer / 会话 cookie），见
 *  handleExternalRequest 的 /api/mobile-logs 分支。 */
export const LOG_QUERY_KEY = randomBytes(32).toString('hex')
export const LOG_QUERY_HEADER = 'x-log-query'
/** 日志查询代理会话的存活时长：仅覆盖单次反代请求，取有限值避免
 *  setTimeout 溢出（Node 32 位毫秒上限 ≈24.8 天，溢出被截断为 1ms；30 天
 *  token 的真实 expiresAt 正好超限，所以这里必须夹住）。 */
const LOG_QUERY_SESSION_TTL_MS = 60 * 60 * 1000
/** 页面错误守卫上报令牌（POST /log-ingest）：**只认页面令牌**——它由部署经
 *  __DSH_INGEST_TOKEN__ 注入到（登录后才拿得到的）页面里，不进 App。
 *  0.3.41 起原先与它并列的「部署令牌」已整体退役：App 原生上报改走
 *  POST /mobile-access/log-report（凭账号会话）。轮换只需同步 profile 的
 *  ingestPageToken + frps nginx dsh-mobile.conf + supervisor。 */
const LOG_INGEST_PAGE_TOKEN = 'dshm-page-ingest-7f3a91c4e6b2d805'
/** 本地上报体上限（守卫单条文本 JSON，1 MiB 远超实际）。 */
const LOG_INGEST_MAX_BODY_BYTES = 1024 * 1024
/** 本地 logstash HTTP 通道（http input，任意路径 200）：公网 nginx 的 18447
 *  隧道同指向该端口；直连网关（无 nginx 层）由此转发守卫上报，403 重试停止。 */
const LOG_INGEST_TARGET = 'http://127.0.0.1:30080/'
/** 本地 APK 分发服务（dsh-apk-dl，仅绑回环 8008）。App 内更新先经网关鉴权、
 *  再由网关按文件名反代到这里；nginx 上那几个公开 dl 入口不受影响，浏览器
 *  下载页保持公开（用户口径：只限 App 内更新要登录）。 */
const APP_DISTRIBUTION_ORIGIN = 'http://127.0.0.1:8008'
const APP_DOWNLOAD_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.apk$/u
const DISCOVERY_QUERY = Buffer.from('DSH_MOBILE_DISCOVER_V1', 'ascii')
const DISCOVERY_PROTOCOL = 1
const DISCOVERY_INTERVAL_MS = 3_000
const MDNS_SERVICE_TYPE = 'dsh-mobile'
const MOBILE_LAYOUT_MODULE = '@deepseek-ai/dsh-client-ui-layout'
const MOBILE_LAYOUT_PATH = `${AUTH_PREFIX}/mobile-layout.js`
const MOBILE_BOOT_BATCH_PREFIX = `${AUTH_PREFIX}/mobile-boot/`
const MAX_MOBILE_BOOT_BATCH_BYTES = 32 * 1024 * 1024
const MAX_MOBILE_BOOT_ENTRY_BYTES = 8 * 1024 * 1024
const MAX_MOBILE_BOOT_BATCHES = 8
const UPSTREAM_AUTH_REFRESH_MARGIN_MS = 60_000
const UPSTREAM_COOKIE_PAIR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[\x21-\x3A\x3C-\x7E]*$/u
const CUSTOM_STYLE_FALLBACK = '/* Add mobile overrides in the DSH home mobile-access/mobile.css file. */\n'
const CUSTOM_SCRIPT_FALLBACK = 'window.dshMobile?.register(() => undefined)\n'
const EXTENSION_CHANGE_POLL_MS = 2_000
const EXTENSION_EVENT_HEARTBEAT_MS = 15_000
const MOBILE_CLIENT_MODULE = '@feiyueve/dsh-mobile'
const CONNECTION_MODULE = '@deepseek-ai/dsh-client-connection'
const RUNTIME_MODULE = '@deepseek-ai/dsh-client-runtime'
const RENDERER_MODULE = '@deepseek-ai/dsh-client-ui-renderer'
const SIDEBAR_MODULE = '@deepseek-ai/dsh-client-ui-sidebar'
const SETTINGS_MODULE = '@deepseek-ai/dsh-client-ui-settings'
const MOBILE_LAYOUT_DEPENDENCY_PROFILES = Object.freeze([
  Object.freeze({
    slots: RUNTIME_MODULE,
    dependencies: Object.freeze([RUNTIME_MODULE, '@deepseek-ai/dsh-client-ui-theme']),
  }),
  Object.freeze({
    slots: RENDERER_MODULE,
    dependencies: Object.freeze([
      '@deepseek-ai/dsh-client-locale',
      RENDERER_MODULE,
      '@deepseek-ai/dsh-client-ui-session',
      '@deepseek-ai/dsh-client-ui-theme',
    ]),
  }),
])
/**
 * Page bootstrap injected ahead of the boot manifest: CSRF header + login redirect.
 *
 * 两条职责，都源自同一个事实——移动页面用**登录 token 的 cookie 形态**
 * （`dsh_ma_session`，默认 30 天，见 `handleAccountLogin`）认证：
 *
 * 1. CSRF：每个同源变更请求带上从可读 cookie 里读到的 `x-dsh-mobile-csrf`
 *    （服务端 `requireCsrf` 与 token 绑定校验，fail-closed）。
 * 2. 掉登录：token 过期 / 被别处踢下线 / 服务端换了账号之后，页面里的同源请求会拿到
 *    401——这时把整页导到 `/mobile-access/login`（账密登录页，带 `return` 回跳），
 *    而不是留一个「自动重连中…」的空壳给用户。
 *
 * 旧实现是「401 → `POST /mobile-access/auth/renew` 续设备会话后重放」；配对模式整体
 * 删除后没有可续的东西了，所以只剩「去登录」这一条路（也不再包 WebSocket 补丁：
 * 手工握手失败无法区分是掉登录还是网络抖动，误判会把整页踢走）。
 */
const MOBILE_SESSION_BOOTSTRAP = `(()=>{const nativeFetch=window.fetch.bind(window);const loginPath=${JSON.stringify(`${AUTH_PREFIX}/login`)};let redirecting=false;const toLogin=()=>{if(redirecting)return;redirecting=true;location.replace(loginPath+'?return='+encodeURIComponent(location.pathname+location.search))};const sameOrigin=raw=>{try{const url=typeof raw==='string'?raw:raw instanceof URL?raw.href:raw?.url;return url!==undefined&&new URL(url,location.href).origin===location.origin}catch{return false}};window.fetch=(input,init)=>{const source=input instanceof Request?input:undefined;const raw=typeof input==='string'?input:input instanceof URL?input.href:source?.url;const local=raw!==undefined&&sameOrigin(raw);const method=String(init?.method??source?.method??'GET').toUpperCase();let nextInit=init;if(local&&method!=='GET'&&method!=='HEAD'){const headers=new Headers(init?.headers??source?.headers);if(!headers.has(${JSON.stringify(CSRF_HEADER)})){const prefix=${JSON.stringify(`${CSRF_COOKIE}=`)};const token=document.cookie.split(';').map(value=>value.trim()).find(value=>value.startsWith(prefix))?.slice(prefix.length);if(token!==undefined)headers.set(${JSON.stringify(CSRF_HEADER)},token)}nextInit={...init,headers}}return nativeFetch(input,nextInit).then(response=>{if(response.status===401&&local)toLogin();return response},error=>{throw error})}})();`

interface BootGraphEntry {
  id: string
  url: string
  rev: string
  inject?: string[]
  immediately?: boolean
}

interface BootGraphBatch {
  phase: 'bootstrap' | 'application'
  url: string
  rev: string
  entries: string[]
}

interface MobileBootBatchEntry {
  readonly id: string
  readonly url: string
  readonly rev: string
}

interface MobileBootBatchPlan {
  readonly key: string
  readonly path: string
  readonly entries: readonly MobileBootBatchEntry[]
}

interface RewrittenMobileIndex {
  readonly html: string
  readonly batch?: MobileBootBatchPlan
}

interface StoredMobileBootBatch {
  readonly plan: MobileBootBatchPlan
  body?: Buffer
  gzipBody?: Buffer
  etag?: string
  layoutMtimeMs?: number
}

const gzipBuffer = promisify(gzip)

function ensureMobileViewport(html: string): string {
  const viewport = /<meta\b(?=[^>]*\bname\s*=\s*["']viewport["'])[^>]*>/iu
  const match = viewport.exec(html)
  if (match === null) {
    const head = /<head\b[^>]*>/iu.exec(html)
    if (head?.index === undefined) return html
    const position = head.index + head[0].length
    return `${html.slice(0, position)}<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${html.slice(position)}`
  }
  if (/\bviewport-fit\s*=\s*cover\b/iu.test(match[0])) return html
  const content = /\bcontent\s*=\s*(["'])(.*?)\1/iu
  const next = content.test(match[0])
    ? match[0].replace(content, (_whole, quote: string, value: string) => `content=${quote}${value},viewport-fit=cover${quote}`)
    : match[0].replace(/\s*\/?>$/u, ' content="width=device-width,initial-scale=1,viewport-fit=cover">')
  return `${html.slice(0, match.index)}${next}${html.slice(match.index + match[0].length)}`
}

function orderAuthenticatedSettings(entries: BootGraphEntry[], slotsProvider: string): void {
  const mobile = entries.filter(entry => entry !== null && typeof entry === 'object' && entry.id === MOBILE_CLIENT_MODULE)
  const settings = entries.filter(entry => entry !== null && typeof entry === 'object' && entry.id === SETTINGS_MODULE)
  if (mobile.length === 0 || settings.length === 0) return
  if (mobile.length !== 1 || settings.length !== 1) throw new Error('upstream DSH mobile settings graph is ambiguous')
  if (!Array.isArray(mobile[0]?.inject)
    || !mobile[0].inject.includes(CONNECTION_MODULE)
    || !mobile[0].inject.includes(SIDEBAR_MODULE)) {
    throw new Error('dsh-mobile client has unsupported dependencies')
  }
  if (!Array.isArray(settings[0]?.inject)) {
    throw new Error('upstream DSH settings module has unsupported dependencies')
  }
  mobile[0].inject = [CONNECTION_MODULE, slotsProvider]
  // dsh ≥0.1.2-alpha.4 的 settings 客户端改经 api-remotes 取数，其 inject 不再直接
  // 依赖 dsh-client-connection；但移动设置页仍由 settings 装载 dsh-mobile 客户端
  // （注入已改写为 connection + slots）。把 connection 一并补入 settings 依赖，使
  // 新代次注入图与 alpha.3 时代（settings 自带 connection）结构一致；旧代次已含
  // connection，此处不改变其行为。
  if (!settings[0].inject.includes(CONNECTION_MODULE)) {
    settings[0].inject = [...settings[0].inject, CONNECTION_MODULE]
  }
  if (!settings[0].inject.includes(MOBILE_CLIENT_MODULE)) settings[0].inject = [...settings[0].inject, MOBILE_CLIENT_MODULE]
}

function revisionedMobileBatchPath(entries: readonly MobileBootBatchEntry[]): { readonly key: string; readonly path: string } {
  const key = createHash('sha256')
    .update(DSH_MOBILE_VERSION)
    .update(JSON.stringify(entries))
    .digest('hex')
  return { key, path: `${MOBILE_BOOT_BATCH_PREFIX}${key}.js` }
}

function rewriteMobileIndexWithBatch(html: string): RewrittenMobileIndex {
  const assignment = /(?:window\.__DSH_BOOT__|globalThis\["__DSH_BOOT__"\])\s*=\s*/u.exec(html)
  if (assignment?.index === undefined) throw new Error('upstream DSH index has no boot manifest')
  const start = assignment.index
  const valueStart = start + assignment[0].length
  const scriptEnd = html.indexOf('</script>', valueStart)
  if (scriptEnd < 0) throw new Error('upstream DSH boot manifest script is incomplete')
  const source = html.slice(valueStart, scriptEnd).trim().replace(/;$/u, '')
  const parsed = JSON.parse(source) as { rev?: unknown; entries?: unknown; batches?: unknown }
  if (typeof parsed.rev !== 'string' || !Array.isArray(parsed.entries)) {
    throw new Error('upstream DSH boot manifest is malformed')
  }
  const entries = parsed.entries as BootGraphEntry[]
  const layout = entries.filter(entry => entry !== null && typeof entry === 'object' && entry.id === MOBILE_LAYOUT_MODULE)
  if (layout.length !== 1 || typeof layout[0]?.url !== 'string' || typeof layout[0].rev !== 'string') {
    throw new Error('upstream DSH boot manifest has no unique layout module')
  }
  if (!Array.isArray(layout[0].inject)) {
    throw new Error('upstream DSH layout module has unsupported dependencies')
  }
  const dependencyProfile = MOBILE_LAYOUT_DEPENDENCY_PROFILES.find(profile => (
    profile.dependencies.every(dependency => layout[0]?.inject?.includes(dependency))
  ))
  if (dependencyProfile === undefined) throw new Error('upstream DSH layout module has unsupported dependencies')
  layout[0].url = MOBILE_LAYOUT_PATH
  layout[0].rev = `dsh-mobile-layout-${DSH_MOBILE_VERSION}`
  orderAuthenticatedSettings(entries, dependencyProfile.slots)

  let mobileBatch: MobileBootBatchPlan | undefined
  if (parsed.batches !== undefined) {
    if (!Array.isArray(parsed.batches)) throw new Error('upstream DSH boot manifest batches are malformed')
    const batches = parsed.batches as BootGraphBatch[]
    const entryById = new Map(entries.map(entry => [entry.id, entry]))
    if (entryById.size !== entries.length) throw new Error('upstream DSH boot manifest has duplicate entries')
    const layoutBatches: BootGraphBatch[] = []
    for (const batch of batches) {
      if (batch === null || typeof batch !== 'object'
        || (batch.phase !== 'bootstrap' && batch.phase !== 'application')
        || typeof batch.url !== 'string' || typeof batch.rev !== 'string'
        || !Array.isArray(batch.entries) || batch.entries.length === 0
        || batch.entries.some(id => typeof id !== 'string' || !entryById.has(id))) {
        throw new Error('upstream DSH boot manifest batches are malformed')
      }
      if (batch.entries.includes(MOBILE_LAYOUT_MODULE)) layoutBatches.push(batch)
    }
    if (layoutBatches.length !== 1 || layoutBatches[0]?.phase !== 'application') {
      throw new Error('upstream DSH boot manifest has no unique application layout batch')
    }
    const layoutBatch = layoutBatches[0]
    const planEntries = layoutBatch.entries.map((id): MobileBootBatchEntry => {
      const entry = entryById.get(id)
      if (entry === undefined || typeof entry.url !== 'string' || typeof entry.rev !== 'string') {
        throw new Error('upstream DSH boot manifest batches are malformed')
      }
      return Object.freeze({ id, url: entry.url, rev: entry.rev })
    })
    const revision = revisionedMobileBatchPath(planEntries)
    layoutBatch.url = revision.path
    layoutBatch.rev = revision.key
    mobileBatch = Object.freeze({ ...revision, entries: Object.freeze(planEntries) })
    parsed.rev = createHash('sha256').update(JSON.stringify({ entries, batches })).digest('hex').slice(0, 16)
  }
  const replacement = `${MOBILE_SESSION_BOOTSTRAP}window.__DSH_MOBILE_FRONTEND__="dedicated";${assignment[0]}${JSON.stringify(parsed)};`
  return Object.freeze({
    html: ensureMobileViewport(stripStockBundlePreload(`${html.slice(0, start)}${replacement}${html.slice(scriptEnd)}`)),
    ...(mobileBatch === undefined ? {} : { batch: mobileBatch }),
  })
}

/**
 * Drop the stock page's `<link rel="preload" as="script" href="/plugins/??…">`（0.1.7 起上游写成相对形态 `plugins/??…`，两种前缀都要认）。
 *
 * Why: upstream preloads the ONE combined client bundle it is about to execute, but this gateway
 * replaces that bundle with its own content-addressed batch (`/mobile-access/mobile-boot/<hash>.js`)
 * plus this rewrite's boot graph — so the preload is never consumed. Measured on a real phone-sized
 * page (Playwright, iPhone 13): the preload still downloaded **4.5 MB** (initiator `link`) next to the
 * 4.07 MB batch, i.e. the whole client payload was fetched twice per entry, and Chromium reported
 * "preloaded but not used within a few seconds from the window's load event". Re-pointing it at the
 * batch would not help either: an `as=script` preload without `crossorigin` fetches in no-CORS mode
 * while the module script fetch is CORS-mode, so the preload can never be reused for a module.
 *
 * Only the stock combined bundle is stripped: any other preload the page carries is left alone.
 */
function stripStockBundlePreload(html: string): string {
  return html.replace(/<link\b[^>]*>/giu, (tag) => (
    /\brel\s*=\s*["']?preload\b/iu.test(tag) && /\bhref\s*=\s*["'][^"']*plugins\/\?\?/iu.test(tag) ? '' : tag
  ))
}

/**
 * Replace only DSH's layout client module while retaining its complete plugin graph.
 *
 * Old-WebView polyfills (`Iterator`, `Promise.try`, `Math.sumPrecise`, `Uint8Array.fromBase64`)
 * are deliberately NOT injected here: the Flutter host owns that gap and injects its own compat
 * script at document start, ahead of every bundle (`dsh-mobile-flutter`
 * `_webViewCompatScript`). One owner keeps the served page from carrying a second copy that
 * drifts from the host's; the gateway rewrite stays limited to replacing the layout module.
 */
export function rewriteMobileIndex(html: string): string {
  return rewriteMobileIndexWithBatch(html).html
}

/**
 * 手机浏览器那条路的登录页（账密，与 App 同一个账号）。
 *
 * 配对模式已整体删除：这里不再有「设备码 / 去电脑上开配对窗」的入口，凭据只有
 * 一个来源——账号密码换来的一个月 token（`POST /mobile-access/auth/login`）。
 */
const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>登录 DSH 移动访问</title>
<main>
  <h1>登录</h1>
  <form id="login-form">
    <label>用户名 <input id="login-username" autocomplete="username" required></label>
    <label>密码 <input id="login-password" type="password" autocomplete="current-password" required></label>
    <button type="submit">登录</button>
    <output id="login-status" role="status"></output>
  </form>
</main>
<script src="/mobile-access/login.js" defer></script>
</html>
`

const LOGIN_SCRIPT = `(() => {
  const form = document.getElementById('login-form')
  const username = document.getElementById('login-username')
  const password = document.getElementById('login-password')
  const status = document.getElementById('login-status')
  const candidate = new URL(location.href).searchParams.get('return')
  let returnPath = '/'
  if (candidate && candidate.startsWith('/')) {
    try {
      const resolved = new URL(candidate, location.origin)
      const pathname = decodeURIComponent(resolved.pathname)
      if (resolved.origin === location.origin && pathname !== '/mobile-access'
        && !pathname.startsWith('/mobile-access/') && !pathname.includes('\\\\')) {
        returnPath = resolved.pathname + resolved.search + resolved.hash
      }
    } catch {
      // Malformed untrusted return targets keep the safe root default.
    }
  }
  const reasons = {
    400: '请求不合法',
    401: '用户名或密码不对',
    403: '被网关拒绝（来源校验）',
    404: '服务端没有这个接口（插件版本太旧？）',
    409: '服务端还没配置账号',
    429: '尝试太频繁，稍后再试',
    503: '服务端暂时不可用',
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    status.value = '登录中…'
    let response
    try {
      response = await fetch('/mobile-access/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: username.value, password: password.value, label: 'DSH Mobile (Web)' }),
      })
    } catch {
      status.value = '连不上电脑'
      return
    }
    if (response.ok) {
      location.replace(returnPath)
      return
    }
    let detail = ''
    try {
      const payload = await response.json()
      if (payload && typeof payload.error === 'string') detail = payload.error
    } catch {
      // Non-JSON error bodies keep the status-code wording.
    }
    const reason = reasons[response.status] ?? ('HTTP ' + response.status)
    status.value = detail ? (reason + '（' + detail + '）') : reason
    password.value = ''
  })
})()
`

class ByteLimitTransform extends Transform {
  private total = 0

  constructor(private readonly maximum: number) {
    super()
  }

  override _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
    this.total += buffer.length
    if (this.total > this.maximum) {
      callback(new HttpError(413, 'payload_too_large'))
      return
    }
    callback(null, buffer)
  }
}

/**
 * 丢掉 `/plugins/events` 上 `type:"graph"` 的帧。
 *
 * 为什么必须丢：移动页的 boot graph 是网关**改写过的**——布局模块被换成
 * `mobile-layout.js`（专属移动布局）、布局批次的 URL 被换成 `mobile-boot/<hash>.js`。
 * 但 HMR 客户端一连上 `/plugins/events`，上游就会推一帧**它自己那份 stock graph**，
 * `entries.sync(graph)` 把页面手上的改写图整体覆盖回 stock：布局模块又变回官方
 * `plugins/??@deepseek-ai/dsh-client-ui-layout/client.js` 并被重新拉取，专属布局的注册
 * 被冲掉，shell 渲染 `root` 插槽时一个注册都还没有 →
 * `SlotAssemblyError: renderSlot('root') before any 'root' registration (boot order)`
 * → React 树崩掉、手机页**白屏**（2026-09-23 在 dsh 0.1.7 上实测；同一次启动里把
 * `/plugins/events` 拦掉，页面立刻正常挂载 `.dshm-shell`）。
 *
 * 只丢 `graph` 帧：`rebuilt`（单模块热替换）与注释帧（`: connected`）原样透传，HMR 心跳
 * 与单模块热更不受影响；从 stock 图同步回来的「插件集变化」对移动页本来就没有意义——
 * 手机页的模块集由网关按移动形态决定，换版本即换内容寻址 URL。
 */
class MobilePluginEventsFilter extends Transform {
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''
  private data: string[] = []

  override _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    const text = this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))
    const out: string[] = []
    this.pending += text
    for (;;) {
      const newline = this.pending.indexOf('\n')
      if (newline < 0) break
      const line = this.pending.slice(0, newline + 1)
      this.pending = this.pending.slice(newline + 1)
      const body = line.replace(/\r?\n$/u, '')
      if (body.length === 0) {
        // 空行 = 一帧结束：data 行拼起来若是一帧 stock graph，整帧丢掉。
        if (!isStockGraphFrame(this.data.join('\n'))) out.push(...this.data.map(entry => `data: ${entry}\n`), '\n')
        this.data = []
        continue
      }
      // data 行按 SSE 规范可多次出现、以换行拼接；这里存**值**（剥掉 `data:` 前缀），
      // 判定与重发都以此为唯一形态，避免把 `data: ` 前缀喂进 JSON.parse。
      if (body.startsWith('data:')) this.data.push(body.slice(5).replace(/^ /u, ''))
      else out.push(line) // 注释 / event / id / retry 行原样透传
    }
    callback(null, out.join(''))
  }

  override _flush(callback: TransformCallback): void {
    const rest = this.pending + this.decoder.end()
    this.pending = ''
    const pendingFrame = this.data.length === 0 ? '' : `${this.data.map(entry => `data: ${entry}\n`).join('')}\n`
    this.data = []
    if (rest.length === 0 && pendingFrame.length === 0) {
      callback()
      return
    }
    callback(null, `${pendingFrame}${rest}`)
  }
}

/** 一帧 SSE data 是否是上游推来的 stock boot graph。 */
function isStockGraphFrame(payload: string): boolean {
  if (!payload.includes('"graph"')) return false
  try {
    const value: unknown = JSON.parse(payload)
    return isJsonRecord(value) && value.type === 'graph'
  } catch {
    return false
  }
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

interface PemCertificate {
  readonly pem: string
  readonly certificate: X509Certificate
}

function parsePemCertificates(contents: Buffer, source: string): PemCertificate[] {
  const text = contents.toString('utf8')
  const pattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu
  const blocks = text.match(pattern) ?? []
  if (blocks.length === 0 || text.replace(pattern, '').trim() !== '') {
    throw new Error(`${source} must contain only PEM certificates`)
  }
  return blocks.map((pem) => {
    let certificate: X509Certificate
    try {
      certificate = new X509Certificate(pem)
    } catch (error) {
      throw new Error(`${source} contains an invalid certificate`, { cause: error })
    }
    return Object.freeze({ pem: `${pem}\n`, certificate })
  })
}

function validateServerChain(chain: readonly PemCertificate[]): void {
  const now = Date.now()
  for (const [index, entry] of chain.entries()) {
    if (Date.parse(entry.certificate.validFrom) > now || Date.parse(entry.certificate.validTo) <= now) {
      throw new Error('TLS certificate chain contains a certificate that is not currently valid')
    }
    if (index === 0) continue
    if (entry.certificate.subject === entry.certificate.issuer
      && entry.certificate.verify(entry.certificate.publicKey)) {
      throw new Error('TLS server certificate chain must not include a self-signed root')
    }
    const child = chain[index - 1]!.certificate
    if (!entry.certificate.ca || !child.checkIssued(entry.certificate)
      || !child.verify(entry.certificate.publicKey)) {
      throw new Error('TLS server certificate chain is not an ordered leaf-to-intermediate chain')
    }
  }
}

async function tlsOptions(config: ResolvedGatewayConfig): Promise<ServerOptions> {
  if (config.tls.mode === 'disabled') throw new Error('TLS options requested for a disabled listener')
  const [certFile, key, additionalChainFile] = await Promise.all([
    readFile(config.tls.certFile),
    readFile(config.tls.keyFile),
    config.tls.caFile === undefined ? Promise.resolve(undefined) : readFile(config.tls.caFile),
  ])
  const chain = [
    ...parsePemCertificates(certFile, 'tls.certFile'),
    ...(additionalChainFile === undefined ? [] : parsePemCertificates(additionalChainFile, 'tls.caFile')),
  ]
  validateServerChain(chain)
  const leaf = chain[0]!.certificate
  for (const authority of config.authorities) {
    const hostname = stripIpv6Brackets(authority.hostname)
    const match = isIP(hostname) === 0 ? leaf.checkHost(hostname) : leaf.checkIP(hostname)
    if (match === undefined) throw new Error(`TLS certificate does not cover configured authority ${hostname}`)
  }
  return {
    cert: chain.map(entry => entry.pem).join(''),
    key,
    requestCert: false,
    minVersion: 'TLSv1.2',
    maxHeaderSize: MAX_HEADER_BYTES,
  }
}

function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'ascii').digest('base64')
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? undefined : value
}

function hasToken(header: string | undefined, token: string): boolean {
  return header?.split(',').some(value => value.trim().toLowerCase() === token) ?? false
}

function rejectUpgrade(socket: Socket, status: number, code: string): void {
  if (socket.destroyed) return
  const body = `${JSON.stringify({ error: code })}\n`
  socket.end([
    `HTTP/1.1 ${String(status)} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Request'}`,
    'Connection: close',
    'Cache-Control: no-store',
    'Content-Type: application/json; charset=utf-8',
    'Referrer-Policy: no-referrer',
    'X-Content-Type-Options: nosniff',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}

function sanitizeRequestHeaders(
  request: IncomingMessage,
  upstream: URL,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {
    host: upstream.host,
  }
  if (request.headers.origin !== undefined) headers.origin = upstream.origin
  if (request.headers['sec-fetch-site'] !== undefined) headers['sec-fetch-site'] = 'same-origin'
  const allowed = [
    'accept', 'accept-encoding', 'accept-language', 'content-encoding', 'content-length', 'content-type',
    'if-match', 'if-modified-since', 'if-none-match', 'if-unmodified-since', 'range', 'user-agent',
  ] as const
  // `x-log-query` 是网关 → 3080 插件路由的**进程内**共享键（LOG_QUERY_KEY），
  // 由 proxyHttp 的 extraHeaders 显式注入：客户端给的同名头一律丢掉（0.3.41 前
  // 它曾是「客户端自带凭据」，放行转发、由 upstream 二次校验）。
  for (const name of allowed) {
    const value = request.headers[name]
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return headers
}

const BLOCKED_RESPONSE_HEADERS = new Set([
  'alt-svc', 'cache-control', 'connection', 'content-security-policy', 'content-security-policy-report-only',
  'cross-origin-embedder-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'expires',
  'keep-alive', 'nel', 'permissions-policy', 'pragma', 'proxy-authenticate', 'referrer-policy',
  'report-to', 'reporting-endpoints', 'server', 'set-cookie', 'strict-transport-security', 'trailer',
  'transfer-encoding', 'upgrade', 'via', 'x-content-type-options', 'x-frame-options', 'x-powered-by',
])

function sanitizeResponseHeaders(headers: IncomingHttpHeaders, upstream: URL): OutgoingHttpHeaders {
  const clean: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (value === undefined || BLOCKED_RESPONSE_HEADERS.has(lower) || lower.startsWith('access-control-')) continue
    if (lower === 'location' && typeof value === 'string') {
      try {
        const location = new URL(value, upstream)
        clean.location = location.origin === upstream.origin
          ? `${location.pathname}${location.search}${location.hash}`
          : value
      } catch {
        continue
      }
      continue
    }
    clean[lower] = value
  }
  return clean
}

function acceptsGzip(header: string | undefined): boolean {
  if (header === undefined) return false
  let wildcard: boolean | undefined
  for (const entry of header.split(',')) {
    const [rawName, ...parameters] = entry.split(';')
    const name = rawName?.trim().toLowerCase()
    if (name === undefined || name === '') continue
    let quality = 1
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*$/iu.exec(parameter)
      if (match !== null) quality = Number(match[1])
    }
    if (name === 'gzip') return quality > 0
    if (name === '*') wildcard = quality > 0
  }
  return wildcard ?? false
}

function isCompressibleContentType(value: string | string[] | undefined): boolean {
  const contentType = Array.isArray(value) ? value[0] : value
  if (contentType === undefined) return false
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return mediaType.startsWith('text/')
    || /^(?:application\/(?:javascript|json|xml|x-javascript)|image\/svg\+xml)$/u.test(mediaType)
}

/** 移动页订阅的那条 HMR 通道（文档相对路径，网关侧按 pathname 判定）。 */
function isPluginEventsRequest(request: IncomingMessage): boolean {
  return request.method === 'GET' && (request.url?.split('?', 1)[0] ?? '') === '/plugins/events'
}

function isEventStreamContentType(value: string | string[] | undefined): boolean {
  const contentType = Array.isArray(value) ? value[0] : value
  if (contentType === undefined) return false
  return (contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '') === 'text/event-stream'
}

function shouldCompressResponse(request: IncomingMessage, response: IncomingMessage): boolean {
  const pathname = request.url?.split('?', 1)[0] ?? ''
  const compressibleRequest = (request.method === 'GET'
      && (pathname.startsWith('/plugins/') || pathname.startsWith('/assets/')))
    || (request.method === 'POST' && pathname === SESSION_HISTORY_PATH)
  return compressibleRequest
    && response.statusCode === 200
    && request.headers.range === undefined
    && response.headers['content-range'] === undefined
    && response.headers['content-encoding'] === undefined
    && acceptsGzip(request.headers['accept-encoding'])
    // SSE 长连接**绝不能压缩**：gzip 转换会缓冲小帧（实测把
    // `: connected\n\n` + 一帧 data 喂进 createGzip 后客户端 8s 内收不到任何
    // 字节），`/plugins/events` 的 connected/rebuilt 帧会被整段吞掉，连接随之
    // 长时间零流量 → 撞上游空闲超时（见 proxyHttp 的 SSE 处理）。
    && !isEventStreamContentType(response.headers['content-type'])
    && isCompressibleContentType(response.headers['content-type'])
}

function revisionedStaticCacheControl(request: IncomingMessage): string | undefined {
  if (request.method !== 'GET' && request.method !== 'HEAD') return undefined
  let target: URL
  try { target = new URL(request.url ?? '/', 'https://dsh-mobile.invalid') } catch { return undefined }
  const revision = target.searchParams.get('rev')
  const hasRevision = revision !== null && /^[a-z0-9_-]{4,128}$/iu.test(revision)
  const hashedAsset = /^\/assets\/.*-[a-z0-9_-]{8,}\.[a-z0-9]+$/iu.test(target.pathname)
  if (!(target.pathname.startsWith('/plugins/') && hasRevision)
    && !(target.pathname.startsWith('/assets/') && (hasRevision || hashedAsset))) return undefined
  return 'private, max-age=31536000, immutable'
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mobileHistoryRequestBody(request: IncomingMessage, body: Buffer): Buffer {
  if (request.method !== 'POST' || request.url?.split('?', 1)[0] !== SESSION_HISTORY_PATH) return body
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return body
  }
  if (!isJsonRecord(parsed) || parsed.method !== 'session.history' || !isJsonRecord(parsed.payload)) return body
  const requested = parsed.payload.maxMessages
  if (typeof requested === 'number' && Number.isInteger(requested) && requested > 0 && requested <= MOBILE_HISTORY_PAGE_MESSAGES) {
    return body
  }
  return Buffer.from(JSON.stringify({
    ...parsed,
    payload: { ...parsed.payload, maxMessages: MOBILE_HISTORY_PAGE_MESSAGES },
  }))
}

function addVaryAcceptEncoding(headers: OutgoingHttpHeaders): void {
  const existing = headers.vary
  const rawValues: string[] = Array.isArray(existing)
    ? existing.map(value => String(value))
    : existing === undefined ? [] : [String(existing)]
  const values = rawValues.flatMap(value => value.split(',').map(part => part.trim()).filter(Boolean))
  if (!values.some(value => value.toLowerCase() === 'accept-encoding')) values.push('Accept-Encoding')
  headers.vary = values.join(', ')
}

function requestCookies(request: IncomingMessage): ReadonlyMap<string, string> {
  const cookies = parseCookies(request.headers.cookie)
  if (cookies === undefined) throw new HttpError(401, 'authentication_failed')
  return cookies
}

function mapError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (error instanceof AccessError) return new HttpError(error.status, error.code)
  if (error instanceof MobileExtensionError) return new HttpError(error.status, error.code)
  return new HttpError(500, 'internal_error')
}

function discoveryDeviceName(): string {
  const value = hostname().trim().replaceAll(/[\u0000-\u001f\u007f]/gu, '')
  return (value === '' ? 'DeepSeek Harness' : value).slice(0, 63)
}

function discoveryMdnsHost(instanceId: string): string {
  const label = hostname().toLowerCase().replaceAll(/[^a-z0-9-]/gu, '-').replaceAll(/^-+|-+$/gu, '').slice(0, 40)
  return `${label === '' ? 'dsh' : label}-${instanceId.slice(0, 8)}.local`
}

function discoveryBroadcastTargets(cidrs: readonly ParsedCidr[]): readonly string[] {
  const targets = new Set<string>(['255.255.255.255'])
  for (const cidr of cidrs) {
    if (cidr.bits !== 32 || cidr.prefix >= 32) continue
    const hostBits = BigInt(32 - cidr.prefix)
    const broadcast = cidr.network | ((1n << hostBits) - 1n)
    targets.add([24n, 16n, 8n, 0n].map(shift => Number((broadcast >> shift) & 0xffn)).join('.'))
  }
  return [...targets]
}

function extensionTarget(pathname: string):
  | { readonly kind: 'manifest' }
  | { readonly kind: 'events' }
  | { readonly kind: 'script' | 'style' | 'asset'; readonly id: string; readonly path?: string }
  | { readonly kind: 'action'; readonly id: string; readonly action: string }
  | { readonly kind: 'route'; readonly id: string; readonly path: string }
  | undefined {
  const prefix = `${AUTH_PREFIX}/extensions`
  if (pathname === prefix || pathname === `${prefix}/` || pathname === `${prefix}/manifest`) return { kind: 'manifest' }
  if (pathname === `${prefix}/events`) return { kind: 'events' }
  if (!pathname.startsWith(`${prefix}/`)) return undefined
  const parts = pathname.slice(prefix.length + 1).split('/')
  const id = parts.shift()
  if (id === undefined || !/^[a-z][a-z0-9-]{0,63}$/u.test(id)) return undefined
  const leaf = parts.shift()
  if (leaf === 'mobile.js' && parts.length === 0) return { kind: 'script', id }
  if (leaf === 'mobile.css' && parts.length === 0) return { kind: 'style', id }
  if (leaf === 'assets' && parts.length > 0) return { kind: 'asset', id, path: parts.join('/') }
  if (leaf === 'actions' && parts.length === 1 && /^[a-z][a-z0-9-]{0,63}$/u.test(parts[0]!)) return { kind: 'action', id, action: parts[0]! }
  if (leaf === 'routes') return { kind: 'route', id, path: `/${parts.join('/')}`.replace(/\/{2,}/gu, '/') }
  return undefined
}

const EXTENSION_GENERATION_HEADER = 'x-dsh-mobile-extension-generation'

function extensionGeneration(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!/^[a-f\d]{64}$/u.test(value)) throw new HttpError(400, 'invalid_extension_generation')
  return value
}

function mobileBootBatchKey(pathname: string): string | undefined {
  const match = new RegExp(`^${MOBILE_BOOT_BATCH_PREFIX.replaceAll('/', '\\/')}([a-f\\d]{64})\\.js$`, 'u').exec(pathname)
  return match?.[1]
}

function assertBoundedContentLength(request: IncomingMessage, maximum: number): void {
  const declared = request.headers['content-length']
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
    throw new HttpError(413, 'payload_too_large')
  }
}

async function readBoundedBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  assertBoundedContentLength(request, maximum)
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maximum) throw new HttpError(413, 'payload_too_large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function extensionRequestHeaders(headers: IncomingHttpHeaders): Readonly<Record<string, string>> {
  const allowed = new Set(['accept', 'content-type', 'content-length', 'content-range', 'range', 'if-none-match', 'if-modified-since'])
  const output: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!allowed.has(name) || typeof value !== 'string') continue
    output[name] = value
  }
  return Object.freeze(output)
}

function extensionContentType(path: string): string {
  const type = {
    '.css': 'text/css; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  }[extname(path).toLowerCase()]
  return type ?? 'application/octet-stream'
}

/** Authenticated TLS edge in front of the ordinary loopback-only DSH Web server. */
export class MobileAccessGateway {
  private readonly listenerTlsEnabled: boolean
  private readonly tlsEnabled: boolean
  private policy: RequestTrustPolicy | undefined
  private server: GatewayServer | undefined
  private discoverySocket: DatagramSocket | undefined
  private discoveryTimer: NodeJS.Timeout | undefined
  private bonjour: Bonjour | undefined
  private pairingCaCertificate: string | undefined
  private listenerPort: number | undefined
  private readonly connectedSockets = new Set<Socket>()
  private readonly activeRequests = new Map<number, ActiveRequest>()
  private readonly activeWebSockets = new Map<number, ActiveWebSocket>()
  private readonly mobileBootBatches = new Map<string, StoredMobileBootBatch>()
  private readonly extensionEventListeners = new Set<(revision: number) => void>()
  private extensionEventRevision = 0
  private extensionChangeTimer: NodeJS.Timeout | undefined
  private extensionChangeTask: Promise<void> | undefined
  private legacyCustomDigest = ''
  private upstreamCookie: string | undefined
  private upstreamCookieExpiresAt = 0
  private upstreamCookieTask: Promise<string> | undefined
  private upstreamAuthRequest: ClientRequest | undefined
  private nextOperationId = 1
  private closing = false
  private started = false
  private closeTask: Promise<void> | undefined
  private readonly removeTokenListener: () => void
  private readonly removeExtensionContentListener: () => void

  constructor(
    readonly config: ResolvedGatewayConfig,
    /** 唯一的凭据来源：单账号 + 一个月 token（配对/设备会话已整体删除）。 */
    private readonly account: AccountController,
    private readonly extensions?: MobileAccessService,
    private readonly upstreamAuthenticatedUrl?: string,
  ) {
    this.listenerTlsEnabled = config.tls.mode === 'provided'
    this.tlsEnabled = config.publicTls
    this.removeTokenListener = this.account.onTokenEnded(authorization => {
      this.abortSessionResources(authorization.sessionKey)
    })
    this.removeExtensionContentListener = this.extensions?.onContentChanged(() => {
      this.broadcastExtensionChange()
    }) ?? (() => undefined)
  }

  /** Initialize durable state, validate TLS, and bind the externally reachable listener. */
  async start(): Promise<void> {
    if (this.started || this.server !== undefined) throw new Error('mobile-access gateway cannot be started twice')
    this.started = true
    await this.account.initialize()
    try {
      if (this.config.pairingCaFile !== undefined) {
        const certificate = new X509Certificate(await readFile(this.config.pairingCaFile))
        const fingerprint = certificate.fingerprint256.replaceAll(':', '').toLowerCase()
        if (!certificate.ca || certificate.subject !== certificate.issuer
          || !certificate.verify(certificate.publicKey) || fingerprint !== this.config.instanceId) {
          throw new Error('pairingCaFile must be the self-signed CA identified by instanceId')
        }
        this.pairingCaCertificate = certificate.raw.toString('base64')
      }
      const handler = (request: IncomingMessage, response: ServerResponse): void => {
        void this.handleExternalRequest(request, response).catch((error: unknown) => {
          const mapped = mapError(error)
          if (response.headersSent) response.destroy()
          else sendFailure(response, mapped.status, mapped.code, this.tlsEnabled)
        })
      }
      const server = this.listenerTlsEnabled
        ? createHttpsServer(await tlsOptions(this.config), handler)
        : createHttpServer({ maxHeaderSize: MAX_HEADER_BYTES }, handler)
      this.server = server
      server.maxHeadersCount = 64
      server.maxConnections = this.config.maxConnections
      server.headersTimeout = 10_000
      server.requestTimeout = this.config.upstreamTimeoutMs
      server.keepAliveTimeout = 5_000
      server.on('connection', (socket: Socket) => {
        if (this.connectedSockets.size >= this.config.maxConnections) {
          socket.destroy()
          return
        }
        this.connectedSockets.add(socket)
        socket.on('error', () => { socket.destroy() })
        socket.once('close', () => { this.connectedSockets.delete(socket) })
      })
      server.on('connect', (_request, socket) => { socket.destroy() })
      server.on('upgrade', (request, socket, head) => {
        void this.handleUpgrade(request, socket as Socket, head).catch((error: unknown) => {
          const mapped = mapError(error)
          rejectUpgrade(socket as Socket, mapped.status, mapped.code)
        })
      })
      server.on('clientError', (_error, socket) => { rejectUpgrade(socket as Socket, 400, 'bad_request') })
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => { reject(error) }
        server.once('error', failed)
        server.listen(this.config.listenPort, this.config.listenHost, () => {
          server.off('error', failed)
          resolve()
        })
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('gateway listener has no TCP address')
      this.listenerPort = address.port
      this.policy = new RequestTrustPolicy(
        this.config.authorities,
        address.port,
        this.config.allowedCidrs,
        this.tlsEnabled,
        this.config.allowIpLiteralHosts,
      )
      if (this.config.discovery) await this.startDiscovery(address.port)
      await this.pollLegacyCustomChanges()
      this.extensionChangeTimer = setInterval(() => { void this.pollLegacyCustomChanges() }, EXTENSION_CHANGE_POLL_MS)
      this.extensionChangeTimer.unref()
    } catch (error) {
      await this.closeFailedStart()
      throw error
    }
  }

  private async startDiscovery(port: number): Promise<void> {
    const socket = createSocket('udp4')
    this.discoverySocket = socket
    const announcement = this.discoveryAnnouncement(port)
    socket.on('message', (message, remote) => {
      if (this.closing || !message.equals(DISCOVERY_QUERY)
        || !addressAllowed(remote.address, this.config.allowedCidrs)) return
      socket.send(announcement, remote.port, remote.address, () => undefined)
    })
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => { reject(error) }
      socket.once('error', failed)
      // The UDP socket is IPv4-only; only a literal IPv4 loopback address is bindable, never ::1.
      const bindHost = isIP(this.config.listenHost) === 4 && isLoopbackAddress(this.config.listenHost) ? this.config.listenHost : '0.0.0.0'
      socket.bind(port, bindHost, () => {
        socket.off('error', failed)
        socket.setBroadcast(true)
        resolve()
      })
    })
    const announce = (): void => {
      for (const target of discoveryBroadcastTargets(this.config.allowedCidrs)) {
        socket.send(announcement, port, target, () => undefined)
      }
    }
    announce()
    this.discoveryTimer = setInterval(announce, DISCOVERY_INTERVAL_MS)
    this.discoveryTimer.unref()

    const deviceName = discoveryDeviceName()
    const bonjour = new Bonjour({ disableIPv6: true })
    this.bonjour = bonjour
    bonjour.publish({
      name: `${deviceName} (${this.config.instanceId.slice(0, 8)})`,
      type: MDNS_SERVICE_TYPE,
      protocol: 'tcp',
      port,
      host: discoveryMdnsHost(this.config.instanceId),
      disableIPv6: true,
      txt: {
        deviceName,
        origin: this.address().origin,
        instanceId: this.config.instanceId,
        protocol: String(DISCOVERY_PROTOCOL),
      },
    })
  }

  private discoveryAnnouncement(port: number): Buffer {
    return Buffer.from(JSON.stringify({
      deviceName: discoveryDeviceName(),
      origin: this.address().origin,
      port,
      protocol: DISCOVERY_PROTOCOL,
      instanceId: this.config.instanceId,
    }), 'utf8')
  }

  private async closeFailedStart(): Promise<void> {
    if (this.extensionChangeTimer !== undefined) clearInterval(this.extensionChangeTimer)
    this.extensionChangeTimer = undefined
    this.removeExtensionContentListener()
    if (this.discoveryTimer !== undefined) clearInterval(this.discoveryTimer)
    this.discoveryTimer = undefined
    await this.closeBonjour()
    this.discoverySocket?.close()
    this.discoverySocket = undefined
    for (const socket of this.connectedSockets) socket.destroy()
    const server = this.server
    this.server = undefined
    if (server?.listening === true) {
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  }

  private async closeBonjour(): Promise<void> {
    const bonjour = this.bonjour
    this.bonjour = undefined
    if (bonjour === undefined) return
    await new Promise<void>(resolve => {
      bonjour.unpublishAll(() => { bonjour.destroy(() => resolve()) })
    })
  }

  /** Actual bound address, available after start and safe for loopback status output. */
  address(): { host: string; port: number; origin: string } {
    if (this.listenerPort === undefined || this.policy === undefined) throw new Error('gateway is not listening')
    const origin = this.policy.origins.values().next().value as string | undefined
    if (origin === undefined) throw new Error('gateway has no public authority')
    return Object.freeze({ host: this.config.listenHost, port: this.listenerPort, origin })
  }

  private requirePolicy(): RequestTrustPolicy {
    if (this.policy === undefined || this.closing) throw new HttpError(503, 'unavailable')
    return this.policy
  }

  /**
   * 唯一的凭据入口。一元 API 走 `Authorization: Bearer <token>`，WebView 页面走
   * `dsh_ma_session` cookie——同一个登录 token 的两种形态，所以三条线路
   * （局域网 / IPv6 / 公网）共用一套认证，不再有「每 origin 一枚 cookie」。
   *
   * 配对/设备短会话的回落已随配对模式整体删除：不认识的凭据一律 401，
   * 不存在「旧设备令牌也能换到会话」这条旁路。
   */
  private authorize(request: IncomingMessage): SessionAuthorization {
    const credential = this.credentialOf(request)
    if (credential === undefined) throw new HttpError(401, 'authentication_failed')
    const account = this.account.tryAuthorize(credential)
    if (account === undefined) throw new HttpError(401, 'authentication_failed')
    return account
  }

  private credentialOf(request: IncomingMessage): string | undefined {
    // cookie 优先：浏览器/WebView 本来就带 cookie，而请求里另有一枚无关的
    // Authorization 头是合法场景（上游白名单会把它剥掉，不该在这里判 401）。
    const cookie = requestCookies(request).get(SESSION_COOKIE)
    if (cookie !== undefined) return cookie
    const header = headerValue(request.headers, 'authorization')
    if (header === undefined) return undefined
    const match = /^Bearer[ ]+(\S+)$/iu.exec(header.trim())
    const token = match?.[1]
    if (token === undefined) throw new HttpError(401, 'authentication_failed')
    return token
  }

  private requireCsrf(request: IncomingMessage, authorization: SessionAuthorization): void {
    // 只有账号 token 一种凭据了：CSRF 与那枚 token 绑定（account.assertCsrf 是 fail-closed）。
    this.account.assertCsrf(authorization, headerValue(request.headers, CSRF_HEADER))
  }

  private setSessionCookies(response: ServerResponse, result: {
    sessionToken: string
    csrfToken: string
    sessionExpiresAt: number
  }, now: number): void {
    const maxAge = (result.sessionExpiresAt - now) / 1000
    response.setHeader('Set-Cookie', [
      cookie(SESSION_COOKIE, result.sessionToken, { tls: this.tlsEnabled, httpOnly: true, path: '/', maxAgeSeconds: maxAge }),
      cookie(CSRF_COOKIE, result.csrfToken, { tls: this.tlsEnabled, httpOnly: false, path: '/', maxAgeSeconds: maxAge }),
    ])
  }

  /** 账号登录：账密换一个月 token（免会话路由，必须排在 authorize 兜底之前）。 */
  private async handleAccountLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
    if (typeof body.username !== 'string' || typeof body.password !== 'string'
      || (body.label !== undefined && typeof body.label !== 'string')) {
      throw new HttpError(400, 'bad_request')
    }
    const result = await this.account.login(
      request.socket.remoteAddress ?? 'unknown',
      body.username,
      body.password,
      body.label as string | undefined,
    )
    this.setSessionCookies(response, {
      sessionToken: result.token,
      csrfToken: result.csrfToken,
      sessionExpiresAt: result.expiresAt,
    }, Date.now())
    sendJson(response, 200, {
      ok: true,
      loggedIn: true,
      instanceId: this.config.instanceId,
      username: result.username,
      label: result.label,
      tokenId: result.tokenId,
      token: result.token,
      csrfToken: result.csrfToken,
      expiresAt: result.expiresAt,
    }, this.tlsEnabled)
  }

  /**
   * 凭据自检：App 启动时判断缓存 token 还有效吗、还剩多久。
   *
   * **完全没带凭据 = 200 且 `username: null`**（「这台服务端现在没有你的会话」不是
   * 错误——登录页的「检查」按钮、App 启动自检都可能在没有 token 时问一次）。
   * 但**带了**凭据却不认（撤销 / 过期 / 伪造）仍然是 401：那是「你的 token 死了」，
   * 与「你还没登录」是两件事，客户端必须能分开（否则一枚失效 token 会被读成
   * 「一切正常但没登录」，界面就停在原地不提示重新登录）。
   */
  private async handleAccountSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.credentialOf(request) === undefined) {
      sendJson(response, 200, {
        ok: true,
        kind: 'anonymous',
        username: null,
        tokenId: null,
        label: null,
        expiresAt: null,
      }, this.tlsEnabled)
      return
    }
    const authorization = this.authorize(request)
    const tokenId = this.account.tokenIdOf(authorization.sessionKey)
    const summary = tokenId === undefined ? undefined : this.account.listTokens().find(token => token.id === tokenId)
    sendJson(response, 200, {
      ok: true,
      kind: 'account',
      username: this.account.currentUsername() ?? null,
      tokenId: tokenId ?? null,
      label: summary?.label ?? null,
      expiresAt: summary?.expiresAt ?? authorization.expiresAt,
    }, this.tlsEnabled)
  }

  /** 已登录设备列表：自己那枚标 current，供「踢下线」用。 */
  private async handleAccountTokens(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authorization = this.authorize(request)
    if (this.account.owns(authorization.sessionKey) !== true) throw new HttpError(403, 'forbidden')
    const currentId = this.account.tokenIdOf(authorization.sessionKey)
    sendJson(response, 200, {
      ok: true,
      tokens: this.account.listTokens().map(token => ({ ...token, current: token.id === currentId })),
    }, this.tlsEnabled)
  }

  /** 撤销某一枚 token（body `{id}` / `{all:true}` / `{}` 或 `{self:true}` = 撤销自己）。 */
  private async handleAccountRevoke(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authorization = this.authorize(request)
    if (this.account.owns(authorization.sessionKey) !== true) throw new HttpError(403, 'forbidden')
    this.requireCsrf(request, authorization)
    const body = await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
    // 只认 `id` / `all` / `self` 三个键，别的键一律 400。**这是安全边界，不是洁癖**：
    // 「省略 id 就撤销自己」那条兜底很危险——拼错的键（例如 `tokenId`）原本会落进它，
    // 调用方拿到 `{"ok":true,"revoked":1}`，实际被撤的是自己那枚，之后每个请求都 401
    // （2026-10-11 实测踩到：现象像「撤销不可靠」，真相是请求把自己踢下线了）。
    const unknown = Object.keys(body).filter(key => key !== 'id' && key !== 'all' && key !== 'self')
    if (unknown.length > 0) throw new HttpError(400, 'bad_request')
    if (body.all === true) {
      sendJson(response, 200, { ok: true, revoked: await this.account.revokeAll() }, this.tlsEnabled)
      return
    }
    const requested = typeof body.id === 'string' ? body.id : undefined
    const selfRequested = body.self === true || Object.keys(body).length === 0
    const id = requested ?? (selfRequested ? this.account.tokenIdOf(authorization.sessionKey) : undefined)
    if (id === undefined || !/^[a-f\d]{32}$/u.test(id)) throw new HttpError(400, 'bad_request')
    if (!await this.account.revokeToken(id)) throw new HttpError(404, 'not_found')
    sendJson(response, 200, { ok: true, revoked: 1 }, this.tlsEnabled)
  }

  /** App 内更新：先校 token，再按文件名反代本地 APK 服务（流式，不整包进内存）。 */
  private async handleAppDistribution(request: IncomingMessage, response: ServerResponse, file: string): Promise<void> {
    this.authorize(request)
    if (file === 'manifest.json') {
      let upstream: Response
      try {
        upstream = await fetch(`${APP_DISTRIBUTION_ORIGIN}/manifest.json`)
      } catch {
        throw new HttpError(502, 'distribution_unreachable')
      }
      if (!upstream.ok) throw new HttpError(502, `distribution_${String(upstream.status)}`)
      const body = Buffer.from(await upstream.arrayBuffer())
      setSecurityHeaders(response, this.tlsEnabled)
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      })
      response.end(body)
      return
    }
    if (!APP_DOWNLOAD_FILE.test(file)) throw new HttpError(404, 'not_found')
    let upstream: Response
    try {
      upstream = await fetch(`${APP_DISTRIBUTION_ORIGIN}/${file}`)
    } catch {
      throw new HttpError(502, 'distribution_unreachable')
    }
    const stream = upstream.body
    if (!upstream.ok || stream === null) throw new HttpError(502, `distribution_${String(upstream.status)}`)
    setSecurityHeaders(response, this.tlsEnabled)
    const declared = upstream.headers.get('content-length')
    response.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      ...(declared === null ? {} : { 'Content-Length': Number(declared) }),
      'Cache-Control': 'no-store',
    })
    const reader = stream.getReader()
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (chunk.value === undefined) continue
        if (!response.write(Buffer.from(chunk.value))) {
          await new Promise<void>(resolve => { response.once('drain', () => { resolve() }) })
        }
      }
    } finally {
      reader.releaseLock()
    }
    response.end()
  }

  private async handleLogout(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // 空体是合法的：登出没有参数，客户端（含 `fetch(..., {method:'POST'})` 不写 body）
    // 不该因为「没带 JSON」被 400 挡掉——那会让 token 永远撤不掉。
    await readJsonObject(request, MAX_CONTROL_BODY_BYTES, { allowEmpty: true })
    const authorization = this.authorize(request)
    this.requireCsrf(request, authorization)
    await this.account.logout(authorization)
    response.setHeader('Set-Cookie', [
      cookie(SESSION_COOKIE, '', { tls: this.tlsEnabled, httpOnly: true, path: '/', maxAgeSeconds: 0 }),
      cookie(CSRF_COOKIE, '', { tls: this.tlsEnabled, httpOnly: false, path: '/', maxAgeSeconds: 0 }),
    ])
    sendJson(response, 200, { loggedOut: true }, this.tlsEnabled)
  }

  /** 页面错误守卫上报：POST /log-ingest（text/plain JSON，X-Log-Token = 页面令牌）。
   *  公网页面经 nginx 反代到 logstash；直连网关页面此前无此路由 → 守卫每次
   *  5s 无限 403 重试（App http-error warn 刷屏 + 前端错误永不落库）。这里
   *  转发到与 nginx 18447 隧道相同的本地 logstash HTTP 通道。 */
  private async handleLogIngest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = request.headers['x-log-token']
    if (typeof token !== 'string' || token !== LOG_INGEST_PAGE_TOKEN) {
      throw new HttpError(403, 'forbidden')
    }
    await this.forwardLogReport(request, response)
  }

  /** App 原生日志上报：POST /mobile-access/log-report（text/plain JSON）。
   *  凭据是**账号会话**（Bearer / 会话 cookie）——0.3.41 起 App 不再内置任何
   *  静态上报令牌，未登录/被踢即 401（App 侧失败静默、排队等下次）。
   *  不要求 CSRF：这是只写遥测、没有状态可被改写的端点，凭据本身即授权。 */
  private async handleAppLogReport(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.authorize(request)
    await this.forwardLogReport(request, response)
  }

  /** 把一条上报原样喂给本地 logstash（只限大小、不解析 body：通道收文本 JSON）。 */
  private async forwardLogReport(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const declared = request.headers['content-length']
    if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > LOG_INGEST_MAX_BODY_BYTES)) {
      throw new HttpError(413, 'payload_too_large')
    }
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of request) {
      const part = chunk as Buffer
      total += part.length
      if (total > LOG_INGEST_MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large')
      chunks.push(part)
    }
    let upstream: Response
    try {
      upstream = await fetch(LOG_INGEST_TARGET, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: Buffer.concat(chunks),
      })
    } catch {
      throw new HttpError(502, 'ingest_unreachable')
    }
    if (!upstream.ok) throw new HttpError(502, `ingest_${upstream.status}`)
    sendJson(response, 200, { ok: true }, this.tlsEnabled)
  }

  private async handleExternalRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const target = parseRequestTarget(request.url)
    const policy = this.requirePolicy()
    const isMutation = request.method !== 'GET' && request.method !== 'HEAD'
    assertExternalTrust(request, policy, isMutation)
    if (target.decodedPathname === LOCAL_ADMIN_PREFIX || target.decodedPathname.startsWith(`${LOCAL_ADMIN_PREFIX}/`)) {
      throw new HttpError(404, 'not_found')
    }
    if (request.method === 'TRACE' || request.method === 'CONNECT') throw new HttpError(405, 'method_not_allowed')

    if (target.search === '' && request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/health`) {
      sendJson(response, 200, { ok: true }, this.tlsEnabled)
      return
    }
    if (target.search === '' && request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/metadata`) {
      sendJson(response, 200, {
        version: MOBILE_METADATA_VERSION,
        pluginVersion: DSH_MOBILE_VERSION,
        minimumAndroidAppVersion: MINIMUM_ANDROID_APP_VERSION,
        discoveryProtocol: DISCOVERY_PROTOCOL,
        accountConfigured: this.account.hasAccount(),
      }, this.tlsEnabled)
      return
    }
    if (target.search === '' && request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/discovery`) {
      sendJson(response, 200, {
        deviceName: discoveryDeviceName(),
        origin: this.address().origin,
        port: this.address().port,
        protocol: DISCOVERY_PROTOCOL,
        instanceId: this.config.instanceId,
      }, this.tlsEnabled)
      return
    }
    if (target.search === '' && request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/ca.cer`) {
      if (this.pairingCaCertificate === undefined) throw new HttpError(404, 'not_found')
      const body = Buffer.from(this.pairingCaCertificate, 'base64')
      setSecurityHeaders(response, this.tlsEnabled)
      response.writeHead(200, {
        'Content-Type': 'application/pkix-cert',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      })
      response.end(body)
      return
    }
    if (request.method === 'GET'
      && (target.decodedPathname === `${AUTH_PREFIX}/login` || target.decodedPathname === `${AUTH_PREFIX}/login.js`)) {
      if (target.decodedPathname.endsWith('.js') && target.search !== '') throw new HttpError(400, 'bad_request')
      setSecurityHeaders(response, this.tlsEnabled)
      const body = target.decodedPathname.endsWith('.js') ? LOGIN_SCRIPT : LOGIN_PAGE
      response.writeHead(200, {
        'Content-Type': target.decodedPathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      })
      response.end(body)
      return
    }
    if (this.config.staticCacheWorker && request.method === 'GET' && target.search === ''
      && target.decodedPathname === SERVICE_WORKER_PATH) {
      // 移动页 Service Worker 本体:静态脚本不含凭据,与 pair/login 同属免会话
      // 引导资源;浏览器按规范每次导航做字节差量更新检查(no-store 禁止 HTTP
      // 缓存复用)。scope 提升到源根,否则默认只控制 /mobile-access/ 下的页面。
      setSecurityHeaders(response, this.tlsEnabled)
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': Buffer.byteLength(SERVICE_WORKER_SOURCE),
        'Cache-Control': 'no-store',
        'Service-Worker-Allowed': '/',
      })
      response.end(SERVICE_WORKER_SOURCE)
      return
    }
    if (target.search === '' && request.method === 'POST' && target.decodedPathname === `${AUTH_PREFIX}/auth/login`) {
      await this.handleAccountLogin(request, response)
      return
    }
    if (target.search === '' && request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/auth/session`) {
      await this.handleAccountSession(request, response)
      return
    }
    if (target.search === '' && request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/auth/tokens`) {
      await this.handleAccountTokens(request, response)
      return
    }
    if (target.search === '' && request.method === 'POST' && target.decodedPathname === `${AUTH_PREFIX}/auth/tokens/revoke`) {
      await this.handleAccountRevoke(request, response)
      return
    }
    // App 分发是静态文件路由：忽略查询串（客户端加 cache-busting 参数不该 404）。
    if (request.method === 'GET' && target.decodedPathname.startsWith(`${AUTH_PREFIX}/app/`)) {
      await this.handleAppDistribution(request, response, target.decodedPathname.slice(`${AUTH_PREFIX}/app/`.length))
      return
    }
    if (target.search === '' && request.method === 'POST' && target.decodedPathname === `${AUTH_PREFIX}/auth/logout`) {
      await this.handleLogout(request, response)
      return
    }
    // App 原生日志上报（账号会话鉴权，取代 0.3.41 前的静态上报令牌）。
    if (target.search === '' && request.method === 'POST' && target.decodedPathname === `${AUTH_PREFIX}/log-report`) {
      await this.handleAppLogReport(request, response)
      return
    }
    const computerImages = request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/computer-images`
    const computerImage = request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/computer-image`
    const requestedExtension = extensionTarget(target.decodedPathname)
    const requestedMobileBootBatch = mobileBootBatchKey(target.decodedPathname)
    const customAsset = request.method === 'GET'
      ? target.decodedPathname === `${AUTH_PREFIX}/custom.css`
        ? {
            file: this.config.customCssFile,
            contentType: 'text/css; charset=utf-8',
            fallback: CUSTOM_STYLE_FALLBACK,
          }
        : target.decodedPathname === `${AUTH_PREFIX}/custom.js`
          ? {
              file: this.config.customScriptFile,
              contentType: 'text/javascript; charset=utf-8',
              fallback: CUSTOM_SCRIPT_FALLBACK,
            }
          : target.decodedPathname === MOBILE_LAYOUT_PATH
            ? {
                file: this.config.mobileLayoutFile,
                contentType: 'text/javascript; charset=utf-8',
                fallback: undefined,
              }
          : undefined
      : undefined
    if (customAsset === undefined && requestedMobileBootBatch === undefined && !computerImages && !computerImage
      && extensionTarget(target.decodedPathname) === undefined
      && (target.decodedPathname === AUTH_PREFIX || target.decodedPathname.startsWith(`${AUTH_PREFIX}/`))) {
      throw new HttpError(404, 'not_found')
    }

    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST'
      && requestedExtension?.kind !== 'route') {
      throw new HttpError(405, 'method_not_allowed')
    }
    // App 日志查看（GET /api/mobile-logs）：**需要账号会话**（Bearer / 会话
    // cookie）——0.3.41 起不再有内置查询令牌，未登录/被踢即 401（App 回登录页）。
    // 反代给 3080 的插件路由时另注入进程内共享键 LOG_QUERY_KEY：3080 那条路由
    // 无法复用客户端凭据（网关用自己的 upstream cookie 会话代理），也不能裸奔
    // （3080 监听 0.0.0.0，同网段直连者不该读得到移动端日志）。
    // expiresAt 必须是有限值：allocateRequest 的 setTimeout 需 32 位有符号
    // 毫秒内（>24.8 天会被 Node 截断为 1ms，连接被立即销毁）——30 天 token 的
    // 真实 expiresAt 正好超限，所以代理会话的 TTL 一律夹到 1 小时。
    if (request.method === 'GET' && target.decodedPathname === '/api/mobile-logs') {
      const authorization = this.authorize(request)
      await this.proxyHttp(
        request,
        response,
        { ...authorization, expiresAt: Math.min(authorization.expiresAt, Date.now() + LOG_QUERY_SESSION_TTL_MS) },
        { [LOG_QUERY_HEADER]: LOG_QUERY_KEY },
      )
      return
    }
    // 页面错误守卫上报（POST /log-ingest）：与 nginx 公网反代同语义的免授权
    // 直通路由（令牌即授权），直连网关页面由此落库 client-error。
    if (request.method === 'POST' && target.decodedPathname === '/log-ingest') {
      await this.handleLogIngest(request, response)
      return
    }
    // favicon：无会话引导请求（WebView/浏览器启动即拉取，不带 cookie）此前 401
    // JSON → App onReceivedHttpError 每次加载刷一条 http-error warn。直接空响应,
    // 任何 App 版本都不再产生该噪音（0.3.13）。
    if (request.method === 'GET' && (target.decodedPathname === '/favicon.ico' || target.decodedPathname === '/favicon.png')) {
      setSecurityHeaders(response, this.tlsEnabled)
      response.writeHead(204, { 'Content-Length': 0 })
      response.end()
      return
    }
    let authorization: SessionAuthorization
    try {
      authorization = this.authorize(request)
    } catch (error) {
      const mapped = mapError(error)
      const acceptsHtml = request.headers.accept?.split(',').some(value => value.trim().split(';', 1)[0] === 'text/html') ?? false
      const topLevel = request.method === 'GET'
        && acceptsHtml
        && (request.headers['sec-fetch-dest'] === undefined || request.headers['sec-fetch-dest'] === 'document')
        && target.decodedPathname !== '/api'
        && !target.decodedPathname.startsWith('/api/')
      if (mapped.status === 401 && topLevel) {
        const returnPath = target.raw.length <= 2048 ? target.raw : '/'
        setSecurityHeaders(response, this.tlsEnabled)
        response.writeHead(302, {
          Location: `${AUTH_PREFIX}/login?return=${encodeURIComponent(returnPath)}`,
          'Content-Length': 0,
        })
        response.end()
        return
      }
      throw error
    }
    if (isMutation) this.requireCsrf(request, authorization)
    const extension = requestedExtension
    if (extension !== undefined) {
      await this.handleExtensionRequest(extension, target, request, response, authorization)
      return
    }
    if (requestedMobileBootBatch !== undefined) {
      await this.serveMobileBootBatch(requestedMobileBootBatch, request, response, authorization)
      return
    }
    if (customAsset !== undefined) {
      const operation = this.allocateRequest(authorization, response, {})
      try {
        let body: Buffer
        let mtime: Date | undefined
        try {
          body = await readFile(customAsset.file, { signal: operation.signal })
          try {
            const fileStat = await stat(customAsset.file)
            mtime = fileStat.mtime
          } catch { /* keep undefined */ }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          if (customAsset.fallback === undefined) throw new HttpError(503, 'mobile_frontend_unavailable')
          body = Buffer.from(customAsset.fallback)
        }
        if (body.byteLength > 256 * 1024) throw new HttpError(413, 'payload_too_large')
        const etag = createHash('sha256').update(body).digest('hex')
        const ifNoneMatch = headerValue(request.headers, 'if-none-match')
        if (ifNoneMatch !== undefined && ifNoneMatch === etag) {
          setSecurityHeaders(response, this.tlsEnabled)
          response.writeHead(304)
          response.end()
          return
        }
        setSecurityHeaders(response, this.tlsEnabled)
        const responseHeaders: Record<string, string | number> = {
          'Content-Type': customAsset.contentType,
          'Content-Length': body.byteLength,
          'ETag': etag,
        }
        if (mtime !== undefined) responseHeaders['Last-Modified'] = mtime.toUTCString()
        response.writeHead(200, responseHeaders)
        response.end(body)
        return
      } finally {
        operation.release()
      }
    }
    if (computerImages) {
      const operation = this.allocateRequest(authorization, response, {})
      try {
        const query = new URL(target.raw, this.address().origin).searchParams
        sendJson(response, 200, await listComputerImages(query.get('path'), operation.signal), this.tlsEnabled)
        return
      } finally {
        operation.release()
      }
    }
    if (computerImage) {
      const operation = this.allocateRequest(authorization, response, {})
      try {
        const query = new URL(target.raw, this.address().origin).searchParams
        const image = await readComputerImage(query.get('path'), operation.signal)
        setSecurityHeaders(response, this.tlsEnabled)
        response.writeHead(200, {
          'Content-Type': image.contentType,
          'Content-Length': image.body.byteLength,
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(image.name)}`,
        })
        response.end(image.body)
        return
      } finally {
        operation.release()
      }
    }
    const stockFrontend = new URL(target.raw, this.address().origin).searchParams.get('frontend') === 'stock'
    const acceptsHtml = request.headers.accept?.split(',').some(value => value.trim().split(';', 1)[0] === 'text/html') ?? false
    if (request.method === 'GET' && acceptsHtml && !stockFrontend) {
      await this.proxyMobileIndex(request, response, authorization)
      return
    }
    if (stockFrontend && target.decodedPathname === '/') request.url = '/'
    await this.proxyHttp(request, response, authorization)
  }

  private async handleExtensionRequest(
    targetInfo: NonNullable<ReturnType<typeof extensionTarget>>,
    target: ReturnType<typeof parseRequestTarget>,
    request: IncomingMessage,
    response: ServerResponse,
    authorization: SessionAuthorization,
  ): Promise<void> {
    const extensions = this.extensions
    if (extensions === undefined) throw new HttpError(404, 'not_found')
    if (targetInfo.kind === 'events') {
      if (request.method !== 'GET' || target.search !== '') throw new HttpError(request.method === 'GET' ? 400 : 405, request.method === 'GET' ? 'bad_request' : 'method_not_allowed')
      this.openExtensionEventStream(request, response, authorization)
      return
    }
    if (targetInfo.kind === 'manifest') {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed')
      const operation = this.allocateRequest(authorization, response, {})
      try {
        operation.signal.throwIfAborted()
        const customRevision = async (file: string, fallback: string): Promise<string> => {
          let source: Buffer
          try {
            source = await readFile(file, { signal: operation.signal })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            source = Buffer.from(fallback)
          }
          if (source.byteLength > 256 * 1024) throw new HttpError(413, 'payload_too_large')
          return createHash('sha256').update(source).digest('hex')
        }
        const [scriptRevision, styleRevision] = await Promise.all([
          customRevision(this.config.customScriptFile, CUSTOM_SCRIPT_FALLBACK),
          customRevision(this.config.customCssFile, CUSTOM_STYLE_FALLBACK),
        ])
        const body = Buffer.from(JSON.stringify({
          protocol: 1,
          extensions: extensions.manifest(),
          legacy: { scriptRevision, styleRevision },
        }))
        // The ETag must cover extension content, not just the manifest body, so
        // editing mobile.js/css alone invalidates the client's cached manifest.
        const etag = createHash('sha256').update(body).update(extensions.contentDigest()).digest('hex')
        if (headerValue(request.headers, 'if-none-match') === etag) {
          setSecurityHeaders(response, this.tlsEnabled); response.writeHead(304); response.end(); return
        }
        setSecurityHeaders(response, this.tlsEnabled)
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.byteLength, ETag: etag })
        if (request.method === 'HEAD') response.end(); else response.end(body)
        return
      } finally {
        operation.release()
      }
    }
    if (targetInfo.kind === 'script' || targetInfo.kind === 'style' || targetInfo.kind === 'asset') {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed')
      const generation = extensionGeneration(new URLSearchParams(target.search).get('generation') ?? undefined)
      const operation = this.allocateRequest(authorization, response, {})
      try {
        const file = targetInfo.kind === 'script'
          ? await extensions.readClientFile(targetInfo.id, 'script', operation.signal, generation)
          : targetInfo.kind === 'style'
            ? await extensions.readClientFile(targetInfo.id, 'style', operation.signal, generation)
            : await extensions.readAsset(targetInfo.id, targetInfo.path ?? '', operation.signal, generation)
        if (headerValue(request.headers, 'if-none-match') === file.digest) {
          setSecurityHeaders(response, this.tlsEnabled); response.writeHead(304); response.end(); return
        }
        const contentType = targetInfo.kind === 'script'
          ? 'text/javascript; charset=utf-8'
          : targetInfo.kind === 'style' ? 'text/css; charset=utf-8' : extensionContentType(targetInfo.path ?? '')
        setSecurityHeaders(response, this.tlsEnabled)
        response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': file.body.byteLength, ETag: file.digest })
        if (request.method === 'HEAD') response.end(); else response.end(file.body)
        return
      } finally {
        operation.release()
      }
    }
    if (targetInfo.kind === 'action') {
      if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed')
      const maximum = 1024 * 1024
      assertBoundedContentLength(request, maximum)
      const generation = extensionGeneration(headerValue(request.headers, EXTENSION_GENERATION_HEADER))
      const operation = this.allocateRequest(authorization, response, {})
      const abort = new AbortController()
      response.once('close', () => { abort.abort() })
      const generationSignal = extensions.signal(targetInfo.id, generation)
      const onGenerationAbort = (): void => { abort.abort(); if (!response.destroyed) response.destroy() }
      generationSignal?.addEventListener('abort', onGenerationAbort, { once: true })
      try {
        const body = await readJsonObject(request, maximum)
        const result = await extensions.invoke(targetInfo.id, targetInfo.action, body, { signal: abort.signal, deviceId: authorization.deviceId }, generation)
        let serialized: Buffer
        try { serialized = Buffer.from(JSON.stringify(result)) } catch { throw new MobileExtensionError('extension_failed', 'extension action failed', 500) }
        if (serialized.byteLength > 4 * 1024 * 1024) throw new MobileExtensionError('extension_result_too_large', 'extension result is too large', 500)
        sendJson(response, 200, result, this.tlsEnabled)
      } finally {
        generationSignal?.removeEventListener('abort', onGenerationAbort)
        abort.abort(); operation.release()
      }
      return
    }
    if (targetInfo.kind === 'route') {
      const method = request.method ?? 'GET'
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new HttpError(405, 'method_not_allowed')
      const hasBody = method !== 'GET' && method !== 'HEAD'
      if (hasBody) assertBoundedContentLength(request, this.config.maxBodyBytes)
      const generation = extensionGeneration(headerValue(request.headers, EXTENSION_GENERATION_HEADER))
      const operation = this.allocateRequest(authorization, response, {})
      const abort = new AbortController()
      response.once('close', () => { abort.abort() })
      const generationSignal = extensions.signal(targetInfo.id, generation)
      const onGenerationAbort = (): void => { abort.abort(); if (!response.destroyed) response.destroy() }
      generationSignal?.addEventListener('abort', onGenerationAbort, { once: true })
      try {
        const body = hasBody ? await readBoundedBody(request, this.config.maxBodyBytes) : Buffer.alloc(0)
        const parsed = new URL(target.raw, this.address().origin)
        const routeRequest: MobileRouteRequest = {
          method, pathname: targetInfo.path, query: parsed.searchParams,
          headers: extensionRequestHeaders(request.headers), body, signal: abort.signal, deviceId: authorization.deviceId,
        }
        const result = await extensions.route(targetInfo.id, method, targetInfo.path, routeRequest, generation)
        await this.sendExtensionResponse(response, result, request.method === 'HEAD')
      } finally {
        generationSignal?.removeEventListener('abort', onGenerationAbort)
        abort.abort(); operation.release()
      }
    }
  }

  private async sendExtensionResponse(response: ServerResponse, result: MobileRouteResponse, head: boolean): Promise<void> {
    const contentType = result.contentType ?? 'application/octet-stream'
    if (!/^[\w!#$&+.^-]+\/[\w!#$&+.^-]+(?:;[\s\S]*)?$/u.test(contentType)) throw new MobileExtensionError('invalid_route_response', 'extension returned an invalid content type', 500)
    const safeHeaders: Record<string, string> = {}
    for (const [name, value] of Object.entries(result.headers ?? {})) {
      if (!/^(?:content-disposition|cache-control|etag)$/iu.test(name) || /[\r\n]/u.test(value)) continue
      safeHeaders[name] = value
    }
    setSecurityHeaders(response, this.tlsEnabled)
    if (typeof result.body === 'string' || result.body instanceof Uint8Array) {
      const body = typeof result.body === 'string' ? Buffer.from(result.body) : Buffer.from(result.body)
      if (body.byteLength > 4 * 1024 * 1024) throw new MobileExtensionError('extension_result_too_large', 'extension response is too large', 500)
      response.writeHead(result.status ?? 200, { ...safeHeaders, 'Content-Type': contentType, 'Content-Length': body.byteLength })
      if (head) response.end(); else response.end(body)
      return
    }
    response.writeHead(result.status ?? 200, { ...safeHeaders, 'Content-Type': contentType })
    if (head) { result.body.destroy(); response.end(); return }
    await pipeline(result.body, new ByteLimitTransform(4 * 1024 * 1024), response)
  }

  /** Exchange DSH's process-local launch token for an authority-bound cookie kept inside this gateway. */
  private async upstreamCookieHeader(): Promise<string | undefined> {
    if (this.upstreamAuthenticatedUrl === undefined) return undefined
    if (this.upstreamCookie !== undefined
      && this.upstreamCookieExpiresAt > Date.now() + UPSTREAM_AUTH_REFRESH_MARGIN_MS) {
      return this.upstreamCookie
    }
    if (this.upstreamCookieTask !== undefined) return this.upstreamCookieTask
    const task = this.exchangeUpstreamCookie()
    this.upstreamCookieTask = task
    try {
      return await task
    } finally {
      if (this.upstreamCookieTask === task) this.upstreamCookieTask = undefined
    }
  }

  private async exchangeUpstreamCookie(): Promise<string> {
    const authenticatedUrl = this.upstreamAuthenticatedUrl
    if (authenticatedUrl === undefined) throw new HttpError(502, 'upstream_unavailable')
    let target: URL
    try {
      target = new URL(authenticatedUrl)
    } catch {
      throw new HttpError(502, 'upstream_unavailable')
    }
    if (target.origin !== this.config.upstreamOrigin.origin || target.pathname !== '/'
      || target.hash !== '' || target.search === '') {
      throw new HttpError(502, 'upstream_unavailable')
    }
    try {
      const proxied = await new Promise<IncomingMessage>((resolve, reject) => {
        const upstreamRequest = requestHttp({
          protocol: 'http:',
          hostname: stripIpv6Brackets(this.config.upstreamOrigin.hostname),
          port: Number(this.config.upstreamOrigin.port),
          method: 'GET',
          path: `${target.pathname}${target.search}`,
          headers: {
            host: this.config.upstreamOrigin.host,
            accept: 'text/html',
            'accept-encoding': 'identity',
          },
          agent: false,
        })
        this.upstreamAuthRequest = upstreamRequest
        upstreamRequest.setTimeout(this.config.upstreamTimeoutMs, () => {
          upstreamRequest.destroy(new Error('upstream timeout'))
        })
        upstreamRequest.once('response', resolve)
        upstreamRequest.once('error', reject)
        upstreamRequest.end()
      })
      await new Promise<void>((resolve, reject) => {
        proxied.once('end', resolve)
        proxied.once('error', reject)
        proxied.resume()
      })
      const setCookie = proxied.headers['set-cookie']?.[0]
      const pair = setCookie?.split(';', 1)[0]
      const maxAgeText = setCookie === undefined
        ? undefined
        : /(?:^|;\s*)Max-Age=(\d+)(?:;|$)/iu.exec(setCookie)?.[1]
      const maxAgeSeconds = maxAgeText === undefined ? Number.NaN : Number(maxAgeText)
      const expiresAt = Date.now() + maxAgeSeconds * 1000
      if (proxied.statusCode !== 303 || pair === undefined || pair.length > 4096
        || !UPSTREAM_COOKIE_PAIR.test(pair) || !Number.isSafeInteger(expiresAt)
        || maxAgeSeconds <= 0) {
        throw new HttpError(502, 'upstream_unavailable')
      }
      this.upstreamCookie = pair
      this.upstreamCookieExpiresAt = expiresAt
      return pair
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(502, 'upstream_unavailable')
    } finally {
      this.upstreamAuthRequest?.destroy()
      this.upstreamAuthRequest = undefined
    }
  }

  private async proxyMobileIndex(
    request: IncomingMessage,
    response: ServerResponse,
    authorization: SessionAuthorization,
  ): Promise<void> {
    const holder: { request?: ClientRequest } = {}
    const operation = this.allocateRequest(authorization, response, holder)
    try {
      const upstreamHeaders = sanitizeRequestHeaders(request, this.config.upstreamOrigin)
      const upstreamCookie = await this.upstreamCookieHeader()
      if (upstreamCookie !== undefined) upstreamHeaders.cookie = upstreamCookie
      upstreamHeaders['accept-encoding'] = 'identity'
      const proxied = await new Promise<IncomingMessage>((resolve, reject) => {
        const upstreamRequest = requestHttp({
          protocol: 'http:',
          hostname: stripIpv6Brackets(this.config.upstreamOrigin.hostname),
          port: Number(this.config.upstreamOrigin.port),
          method: 'GET',
          path: '/',
          headers: upstreamHeaders,
          agent: false,
        })
        holder.request = upstreamRequest
        upstreamRequest.setTimeout(this.config.upstreamTimeoutMs, () => {
          upstreamRequest.destroy(new Error('upstream timeout'))
        })
        upstreamRequest.once('response', resolve)
        upstreamRequest.once('error', reject)
        upstreamRequest.end()
      })
      if ((proxied.statusCode ?? 502) !== 200) throw new HttpError(502, 'upstream_unavailable')
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of proxied) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.byteLength
        if (bytes > 4 * 1024 * 1024) throw new HttpError(502, 'upstream_unavailable')
        chunks.push(buffer)
      }
      let body: Buffer
      try {
        const rewritten = rewriteMobileIndexWithBatch(Buffer.concat(chunks).toString('utf8'))
        if (rewritten.batch !== undefined) this.rememberMobileBootBatch(rewritten.batch)
        body = Buffer.from(rewritten.html)
      } catch (error) {
        console.warn(`[dsh-mobile] mobile index rewrite failed (${(error as Error)?.message ?? String(error)}); serving raw upstream page`)
        body = Buffer.concat(chunks)
      }
      if (this.config.staticCacheWorker) {
        body = Buffer.from(injectServiceWorkerRegistration(body.toString('utf8')))
      }
      const headers = sanitizeResponseHeaders(proxied.headers, this.config.upstreamOrigin)
      delete headers['content-length']
      delete headers['content-encoding']
      delete headers.etag
      setSecurityHeaders(response, this.tlsEnabled)
      response.writeHead(200, {
        ...headers,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.byteLength,
      })
      response.end(body)
    } catch (error) {
      holder.request?.destroy()
      if (error instanceof HttpError) throw error
      if (response.headersSent) response.destroy()
      else throw new HttpError(502, 'upstream_unavailable')
    } finally {
      operation.release()
    }
  }

  private rememberMobileBootBatch(plan: MobileBootBatchPlan): void {
    const existing = this.mobileBootBatches.get(plan.key)
    this.mobileBootBatches.delete(plan.key)
    this.mobileBootBatches.set(plan.key, existing ?? { plan })
    while (this.mobileBootBatches.size > MAX_MOBILE_BOOT_BATCHES) {
      const oldest = this.mobileBootBatches.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.mobileBootBatches.delete(oldest)
    }
  }

  private async serveMobileBootBatch(
    key: string,
    request: IncomingMessage,
    response: ServerResponse,
    authorization: SessionAuthorization,
  ): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed')
    const stored = this.mobileBootBatches.get(key)
    if (stored === undefined) throw new HttpError(404, 'not_found')
    const operation = this.allocateRequest(authorization, response, {})
    try {
      const layoutStat = await stat(this.config.mobileLayoutFile)
      if (stored.body === undefined || stored.etag === undefined || stored.layoutMtimeMs !== layoutStat.mtimeMs) {
        const body = await this.assembleMobileBootBatch(stored.plan, operation.signal)
        stored.body = body
        delete stored.gzipBody
        stored.etag = createHash('sha256').update(body).digest('hex')
        stored.layoutMtimeMs = layoutStat.mtimeMs
      }
      const compressed = acceptsGzip(request.headers['accept-encoding'])
      const body = compressed
        ? stored.gzipBody ??= await gzipBuffer(stored.body)
        : stored.body
      const etag = compressed ? `${stored.etag}-gzip` : stored.etag
      const headers: OutgoingHttpHeaders = {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': body.byteLength,
        // URL 内容寻址(key=sha256(版本+条目图)),换版本/换条目即换文件名,
        // 可安全长缓存(ETag 仍保留给条件请求与调试)。
        'Cache-Control': 'private, max-age=31536000, immutable',
        ETag: etag,
      }
      if (compressed) headers['Content-Encoding'] = 'gzip'
      addVaryAcceptEncoding(headers)
      if (headerValue(request.headers, 'if-none-match') === etag) {
        setSecurityHeaders(response, this.tlsEnabled)
        response.writeHead(304, { ETag: etag, 'Cache-Control': 'private, max-age=31536000, immutable', Vary: String(headers.vary) })
        response.end()
        return
      }
      setSecurityHeaders(response, this.tlsEnabled)
      response.writeHead(200, headers)
      if (request.method === 'HEAD') response.end()
      else response.end(body)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(503, 'mobile_frontend_unavailable')
      throw error
    } finally {
      operation.release()
    }
  }

  private async assembleMobileBootBatch(plan: MobileBootBatchPlan, signal: AbortSignal): Promise<Buffer> {
    const bodies = new Array<Buffer>(plan.entries.length)
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < plan.entries.length) {
        const index = cursor++
        const entry = plan.entries[index]!
        bodies[index] = entry.id === MOBILE_LAYOUT_MODULE
          ? await readFile(this.config.mobileLayoutFile, { signal })
          : await this.readUpstreamClientBundle(entry.url, signal)
        if (bodies[index]!.byteLength > MAX_MOBILE_BOOT_ENTRY_BYTES) throw new HttpError(502, 'upstream_unavailable')
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, plan.entries.length) }, worker))
    const total = bodies.reduce((bytes, body) => bytes + body.byteLength + 2, 0)
    if (total > MAX_MOBILE_BOOT_BATCH_BYTES) throw new HttpError(502, 'upstream_unavailable')
    return Buffer.concat(bodies.flatMap(body => [body, Buffer.from('\n;\n')]))
  }

  private async readUpstreamClientBundle(source: string, signal: AbortSignal): Promise<Buffer> {
    // Boot manifest 条目 URL 的形态在两代 dsh 之间不一样：0.1.6 及更早是绝对路径
    // `/plugins/??…`，0.1.7 起去掉了前导斜杠（上游 `packages/client/modules/src/index.ts:472`
    // 的 `artifact.url.slice(1)`，同一处 combo 引用也走相对形态）。只认绝对形态会让整份
    // mobile-boot 批次在这一步 502（`upstream_unavailable`），手机上表现为白屏——所以两种
    // 形态都先归一化成绝对路径再取上游。
    const normalized = source.startsWith('/') ? source : `/${source}`
    if (!normalized.startsWith('/plugins/') || normalized.includes('#')) throw new HttpError(502, 'upstream_unavailable')
    const target = new URL(normalized, this.config.upstreamOrigin)
    if (target.origin !== this.config.upstreamOrigin.origin) throw new HttpError(502, 'upstream_unavailable')
    let upstreamRequest: ClientRequest | undefined
    const aborted = (): void => { upstreamRequest?.destroy(new Error('request aborted')) }
    signal.addEventListener('abort', aborted, { once: true })
    try {
      const upstreamCookie = await this.upstreamCookieHeader()
      const proxied = await new Promise<IncomingMessage>((resolve, reject) => {
        upstreamRequest = requestHttp({
          protocol: 'http:',
          hostname: stripIpv6Brackets(this.config.upstreamOrigin.hostname),
          port: Number(this.config.upstreamOrigin.port),
          method: 'GET',
          path: `${target.pathname}${target.search}`,
          headers: {
            host: this.config.upstreamOrigin.host,
            accept: 'text/javascript',
            'accept-encoding': 'identity',
            ...(upstreamCookie === undefined ? {} : { cookie: upstreamCookie }),
          },
          agent: false,
        })
        upstreamRequest.setTimeout(this.config.upstreamTimeoutMs, () => {
          upstreamRequest?.destroy(new Error('upstream timeout'))
        })
        upstreamRequest.once('response', resolve)
        upstreamRequest.once('error', reject)
        upstreamRequest.end()
      })
      if ((proxied.statusCode ?? 502) !== 200) throw new HttpError(502, 'upstream_unavailable')
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of proxied) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.byteLength
        if (bytes > MAX_MOBILE_BOOT_ENTRY_BYTES) throw new HttpError(502, 'upstream_unavailable')
        chunks.push(buffer)
      }
      return Buffer.concat(chunks)
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(502, 'upstream_unavailable')
    } finally {
      signal.removeEventListener('abort', aborted)
      upstreamRequest?.destroy()
    }
  }

  private allocateRequest(
    authorization: SessionAuthorization,
    response: ServerResponse,
    upstream: { request?: ClientRequest },
  ): { id: number; signal: AbortSignal; release: () => void } {
    if (this.activeRequests.size >= this.config.maxActiveRequests) throw new HttpError(429, 'busy')
    const id = this.nextOperationId++
    const controller = new AbortController()
    const abort = (): void => {
      controller.abort()
      upstream.request?.destroy()
      if (!response.destroyed) response.destroy()
    }
    const timer = setTimeout(abort, Math.max(1, authorization.expiresAt - Date.now()))
    timer.unref()
    this.activeRequests.set(id, Object.freeze({ ...authorization, abort, timer }))
    return {
      id,
      signal: controller.signal,
      release: () => {
        const entry = this.activeRequests.get(id)
        if (entry !== undefined) clearTimeout(entry.timer)
        this.activeRequests.delete(id)
      },
    }
  }

  private async proxyHttp(
    request: IncomingMessage,
    response: ServerResponse,
    authorization: SessionAuthorization,
    extraUpstreamHeaders?: Record<string, string>,
  ): Promise<void> {
    const declared = request.headers['content-length']
    if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > this.config.maxBodyBytes)) {
      throw new HttpError(413, 'payload_too_large')
    }
    const holder: { request?: ClientRequest } = {}
    const operation = this.allocateRequest(authorization, response, holder)
    let bodyDone: Promise<void> | undefined
    try {
      const bufferedBody = request.method === 'POST' && request.url?.split('?', 1)[0] === SESSION_HISTORY_PATH
        ? mobileHistoryRequestBody(request, await readBoundedBody(request, this.config.maxBodyBytes))
        : undefined
      const upstreamHeaders = sanitizeRequestHeaders(request, this.config.upstreamOrigin)
      // 显式注入的头放在 sanitize 之后：客户端给的同名头一律盖掉
      // （sanitize 已把 x-log-query 排除在放行列表之外，这里是唯一的写入点）。
      if (extraUpstreamHeaders !== undefined) Object.assign(upstreamHeaders, extraUpstreamHeaders)
      const upstreamCookie = await this.upstreamCookieHeader()
      if (upstreamCookie !== undefined) upstreamHeaders.cookie = upstreamCookie
      if (bufferedBody !== undefined) upstreamHeaders['content-length'] = String(bufferedBody.byteLength)
      const upstreamResponse = new Promise<IncomingMessage>((resolve, reject) => {
        const upstreamRequest = requestHttp({
          protocol: 'http:',
          hostname: stripIpv6Brackets(this.config.upstreamOrigin.hostname),
          port: Number(this.config.upstreamOrigin.port),
          method: request.method,
          path: request.url,
          headers: upstreamHeaders,
          agent: false,
        })
        holder.request = upstreamRequest
        upstreamRequest.setTimeout(this.config.upstreamTimeoutMs, () => {
          upstreamRequest.destroy(new Error('upstream timeout'))
        })
        upstreamRequest.once('response', resolve)
        upstreamRequest.once('error', reject)
        if (bufferedBody === undefined) {
          bodyDone = pipeline(request, new ByteLimitTransform(this.config.maxBodyBytes), upstreamRequest)
        } else {
          upstreamRequest.end(bufferedBody)
          bodyDone = Promise.resolve()
        }
        void bodyDone.catch(reject)
      })
      const proxied = await upstreamResponse
      // SSE 长连接不受上游空闲超时约束（WebSocket 分支在握手后同样
      // `setTimeout(0)`）：`/plugins/events` 这类通道在无事件时长期零流量，
      // 空闲超时会按 upstreamTimeoutMs（线上 300s）destroy 上游请求，客户端只
      // 看到 ERR_INCOMPLETE_CHUNKED_ENCODING——移动端表现为每 5 分钟一次整页
      // 「重连」。生命周期仍由会话过期（allocateRequest 的 expiresAt 定时器）
      // 与客户端断开两处兜底，不会泄漏。
      if (isEventStreamContentType(proxied.headers['content-type'])) holder.request?.setTimeout(0)
      setSecurityHeaders(response, this.tlsEnabled)
      const headers = sanitizeResponseHeaders(proxied.headers, this.config.upstreamOrigin)
      const cacheControl = revisionedStaticCacheControl(request)
      if (cacheControl !== undefined) headers['cache-control'] = cacheControl
      const compressed = shouldCompressResponse(request, proxied)
      if (compressed) {
        delete headers['accept-ranges']
        delete headers['content-length']
        delete headers.etag
        headers['content-encoding'] = 'gzip'
        addVaryAcceptEncoding(headers)
      }
      // 移动页的 /plugins/events 要过一层帧过滤：上游推来的 stock graph 会覆盖掉
      // 网关改写过的 boot graph（见 MobilePluginEventsFilter 的说明）。
      const filterPluginEvents = isPluginEventsRequest(request) && isEventStreamContentType(proxied.headers['content-type'])
      if (filterPluginEvents) delete headers['content-length']
      response.writeHead(proxied.statusCode ?? 502, headers)
      await Promise.all([
        bodyDone,
        filterPluginEvents
          ? pipeline(proxied, new MobilePluginEventsFilter(), response)
          : compressed ? pipeline(proxied, createGzip(), response) : pipeline(proxied, response),
      ])
    } catch (error) {
      holder.request?.destroy()
      await bodyDone?.catch(() => undefined)
      if (error instanceof HttpError) throw error
      if (response.headersSent) response.destroy()
      else throw new HttpError(502, 'upstream_unavailable')
    } finally {
      operation.release()
    }
  }

  private abortSessionResources(sessionKey: string): void {
    for (const request of this.activeRequests.values()) {
      if (request.sessionKey === sessionKey) request.abort()
    }
    for (const socket of this.activeWebSockets.values()) {
      if (socket.sessionKey === sessionKey) {
        socket.client.destroy()
        socket.upstream.destroy()
      }
    }
  }

  private broadcastExtensionChange(): void {
    if (this.closing) return
    this.extensionEventRevision += 1
    for (const listener of this.extensionEventListeners) listener(this.extensionEventRevision)
  }

  private pollLegacyCustomChanges(): Promise<void> {
    if (this.extensionChangeTask !== undefined) return this.extensionChangeTask
    const digestFile = async (path: string, fallback: string): Promise<string> => {
      try {
        const info = await stat(path)
        if (!info.isFile() || info.size > 256 * 1024) return `invalid:${String(info.size)}:${String(info.mtimeMs)}`
        return createHash('sha256').update(await readFile(path)).digest('hex')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createHash('sha256').update(fallback).digest('hex')
        return `error:${String((error as NodeJS.ErrnoException).code ?? 'unknown')}`
      }
    }
    const task = Promise.all([
      digestFile(this.config.customScriptFile, CUSTOM_SCRIPT_FALLBACK),
      digestFile(this.config.customCssFile, CUSTOM_STYLE_FALLBACK),
    ]).then(parts => {
      const next = createHash('sha256').update(parts.join('|')).digest('hex')
      if (this.legacyCustomDigest !== '' && next !== this.legacyCustomDigest) this.broadcastExtensionChange()
      this.legacyCustomDigest = next
    }).finally(() => {
      if (this.extensionChangeTask === task) this.extensionChangeTask = undefined
    })
    this.extensionChangeTask = task
    return task
  }

  private openExtensionEventStream(
    request: IncomingMessage,
    response: ServerResponse,
    authorization: SessionAuthorization,
  ): void {
    const operation = this.allocateRequest(authorization, response, {})
    let closed = false
    let heartbeat: NodeJS.Timeout | undefined
    const close = (): void => {
      if (closed) return
      closed = true
      if (heartbeat !== undefined) clearInterval(heartbeat)
      this.extensionEventListeners.delete(send)
      request.removeListener('aborted', close)
      response.removeListener('close', close)
      operation.release()
    }
    const send = (revision: number): void => {
      if (closed || response.destroyed || response.writableEnded) return
      response.write(`id: ${String(revision)}\nevent: extensions-changed\ndata: {\"revision\":${String(revision)}}\n\n`)
    }
    setSecurityHeaders(response, this.tlsEnabled)
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    response.write('retry: 2000\n: ready\n\n')
    this.extensionEventListeners.add(send)
    heartbeat = setInterval(() => {
      if (!closed && !response.destroyed && !response.writableEnded) response.write(': heartbeat\n\n')
    }, EXTENSION_EVENT_HEARTBEAT_MS)
    heartbeat.unref()
    request.once('aborted', close)
    response.once('close', close)
  }

  private async readUpgradeResponse(upstream: Socket, expectedAccept: string): Promise<{ header: string; remainder: Buffer }> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0)
      const failed = (error: Error): void => { cleanup(); reject(error) }
      const closed = (): void => { cleanup(); reject(new Error('upstream closed during WebSocket handshake')) }
      const data = (chunk: Buffer): void => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length > MAX_HEADER_BYTES) {
          failed(new Error('upstream WebSocket headers are too large'))
          return
        }
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        cleanup()
        const lines = buffer.subarray(0, end).toString('latin1').split('\r\n')
        if (lines.shift() !== 'HTTP/1.1 101 Switching Protocols') {
          reject(new Error('upstream refused WebSocket upgrade'))
          return
        }
        const selected = new Map<string, string>()
        for (const line of lines) {
          const colon = line.indexOf(':')
          if (colon <= 0) {
            reject(new Error('upstream returned malformed WebSocket headers'))
            return
          }
          const name = line.slice(0, colon).trim().toLowerCase()
          const value = line.slice(colon + 1).trim()
          if (selected.has(name)) {
            reject(new Error('upstream returned duplicate WebSocket headers'))
            return
          }
          selected.set(name, value)
        }
        if (selected.get('upgrade')?.toLowerCase() !== 'websocket'
          || !hasToken(selected.get('connection'), 'upgrade')
          || selected.get('sec-websocket-accept') !== expectedAccept) {
          reject(new Error('upstream returned an invalid WebSocket handshake'))
          return
        }
        const output = [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${expectedAccept}`,
        ]
        const protocol = selected.get('sec-websocket-protocol')
        const extensions = selected.get('sec-websocket-extensions')
        if (protocol !== undefined) output.push(`Sec-WebSocket-Protocol: ${protocol}`)
        if (extensions !== undefined) output.push(`Sec-WebSocket-Extensions: ${extensions}`)
        output.push('Referrer-Policy: no-referrer', 'X-Content-Type-Options: nosniff', '', '')
        resolve({ header: output.join('\r\n'), remainder: buffer.subarray(end + 4) })
      }
      const cleanup = (): void => {
        upstream.off('data', data)
        upstream.off('error', failed)
        upstream.off('close', closed)
      }
      upstream.on('data', data)
      upstream.once('error', failed)
      upstream.once('close', closed)
    })
  }

  private async handleUpgrade(request: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    const target = parseRequestTarget(request.url)
    const policy = this.requirePolicy()
    // Android WebView WebSockets do not consistently carry Fetch Metadata.
    // Exact Origin, direct CIDR, exact Host, and the short Session Cookie
    // remain mandatory; when Sec-Fetch-Site is present, assertExternalTrust
    // still requires it to be same-origin.
    assertExternalTrust(request, policy, false)
    if (!policy.acceptsOrigin(request.headers.origin)) throw new HttpError(403, 'forbidden')
    if (target.search !== '' || !WS_PATHS.has(target.decodedPathname)) throw new HttpError(404, 'not_found')
    if (request.method !== 'GET' || headerValue(request.headers, 'upgrade')?.toLowerCase() !== 'websocket'
      || !hasToken(headerValue(request.headers, 'connection'), 'upgrade')) {
      throw new HttpError(400, 'bad_request')
    }
    const key = headerValue(request.headers, 'sec-websocket-key')
    if (key === undefined || headerValue(request.headers, 'sec-websocket-version') !== '13') {
      throw new HttpError(400, 'bad_request')
    }
    let decodedKey: Buffer
    try {
      decodedKey = Buffer.from(key, 'base64')
    } catch {
      throw new HttpError(400, 'bad_request')
    }
    if (decodedKey.length !== 16 || decodedKey.toString('base64') !== key) throw new HttpError(400, 'bad_request')
    const authorization = this.authorize(request)
    if (this.activeWebSockets.size >= this.config.maxWebSockets) throw new HttpError(429, 'busy')
    const upstreamCookie = await this.upstreamCookieHeader()

    const upstream = connect({
      host: stripIpv6Brackets(this.config.upstreamOrigin.hostname),
      port: Number(this.config.upstreamOrigin.port),
    })
    client.pause()
    const id = this.nextOperationId++
    const closeBoth = (): void => {
      client.destroy()
      upstream.destroy()
    }
    client.on('error', closeBoth)
    upstream.on('error', closeBoth)
    const timer = setTimeout(closeBoth, Math.max(1, authorization.expiresAt - Date.now()))
    timer.unref()
    const record: ActiveWebSocket = Object.freeze({ ...authorization, client, upstream, timer })
    this.activeWebSockets.set(id, record)
    const cleanup = (): void => {
      const active = this.activeWebSockets.get(id)
      if (active !== undefined) clearTimeout(active.timer)
      this.activeWebSockets.delete(id)
    }
    client.once('close', () => { upstream.destroy(); cleanup() })
    upstream.once('close', () => { client.destroy(); cleanup() })
    upstream.setTimeout(this.config.upstreamTimeoutMs, closeBoth)
    try {
      await new Promise<void>((resolve, reject) => {
        const connected = (): void => {
          upstream.off('error', failed)
          resolve()
        }
        const failed = (error: Error): void => {
          upstream.off('connect', connected)
          reject(error)
        }
        upstream.once('connect', connected)
        upstream.once('error', failed)
      })
      const requestLines = [
        `GET ${target.raw} HTTP/1.1`,
        `Host: ${this.config.upstreamOrigin.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Origin: ${this.config.upstreamOrigin.origin}`,
        'Sec-Fetch-Site: same-origin',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ]
      if (upstreamCookie !== undefined) requestLines.push(`Cookie: ${upstreamCookie}`)
      const protocol = headerValue(request.headers, 'sec-websocket-protocol')
      const extensions = headerValue(request.headers, 'sec-websocket-extensions')
      if (protocol !== undefined) requestLines.push(`Sec-WebSocket-Protocol: ${protocol}`)
      if (extensions !== undefined) requestLines.push(`Sec-WebSocket-Extensions: ${extensions}`)
      requestLines.push('', '')
      upstream.write(requestLines.join('\r\n'))
      if (head.length > 0) upstream.write(head)
      const handshake = await this.readUpgradeResponse(upstream, websocketAccept(key))
      upstream.setTimeout(0)
      client.write(handshake.header)
      if (handshake.remainder.length > 0) client.write(handshake.remainder)
      upstream.pipe(client)
      client.pipe(upstream)
      client.resume()
    } catch (error) {
      closeBoth()
      if (error instanceof HttpError) throw error
      throw new HttpError(502, 'upstream_unavailable')
    }
  }

  /** Loopback-only DSH WebServer route for opening pairing and managing devices. */
  localAdminRoute(prefix: string = LOCAL_ADMIN_PREFIX): WebRoute {
    return {
      kind: 'prefix',
      path: prefix,
      handler: async (request, response) => {
        try {
          const target = parseRequestTarget(request.url)
          const mutation = request.method === 'POST'
          assertLocalAdminTrust(request, mutation)
          if (target.search !== '') throw new HttpError(400, 'bad_request')
          if (request.method === 'GET' && target.decodedPathname === `${prefix}/status`) {
            sendJson(response, 200, {
              gateway: this.address(),
              accountConfigured: this.account.hasAccount(),
              tokenCount: this.account.listTokens().length,
              resources: {
                connections: this.connectedSockets.size,
                activeRequests: this.activeRequests.size,
                webSockets: this.activeWebSockets.size,
              },
            }, false)
            return
          }
          if (request.method === 'POST' && target.decodedPathname === `${prefix}/account`) {
                    const body = await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
            if (typeof body.username !== 'string' || typeof body.password !== 'string') {
              throw new HttpError(400, 'bad_request')
            }
            const result = await this.account.setAccount(body.username, body.password)
            sendJson(response, 200, { configured: true, ...result }, false)
            return
          }
          if (request.method === 'GET' && target.decodedPathname === `${prefix}/tokens`) {
            sendJson(response, 200, {
              account: this.account.currentUsername() ?? null,
              tokens: this.account.listTokens() ?? [],
            }, false)
            return
          }
          if (request.method === 'POST' && target.decodedPathname === `${prefix}/tokens/revoke`) {
                    const body = await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
            if (body.all === true) {
              sendJson(response, 200, { revoked: await this.account.revokeAll() }, false)
              return
            }
            if (typeof body.id !== 'string' || !/^[a-f\d]{32}$/u.test(body.id)) throw new HttpError(400, 'bad_request')
            if (!await this.account.revokeToken(body.id)) throw new HttpError(404, 'not_found')
            sendJson(response, 200, { revoked: 1 }, false)
            return
          }
          throw new HttpError(404, 'not_found')
        } catch (error) {
          const mapped = mapError(error)
          if (response.headersSent) response.destroy()
          else sendFailure(response, mapped.status, mapped.code, false)
        }
      },
    }
  }

  /** Close listeners and abort all accepted work before resolving teardown. */
  async close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask
    this.closeTask = this.performClose()
    return this.closeTask
  }

  private async performClose(): Promise<void> {
    this.closing = true
    if (this.extensionChangeTimer !== undefined) clearInterval(this.extensionChangeTimer)
    this.extensionChangeTimer = undefined
    this.removeExtensionContentListener()
    this.upstreamAuthRequest?.destroy()
    this.upstreamAuthRequest = undefined
    this.removeTokenListener()
    const accountClose = this.account.close()
    for (const request of this.activeRequests.values()) request.abort()
    for (const websocket of this.activeWebSockets.values()) {
      websocket.client.destroy()
      websocket.upstream.destroy()
    }
    for (const socket of this.connectedSockets) socket.destroy()
    if (this.discoveryTimer !== undefined) clearInterval(this.discoveryTimer)
    this.discoveryTimer = undefined
    await this.closeBonjour()
    const discoverySocket = this.discoverySocket
    this.discoverySocket = undefined
    if (discoverySocket !== undefined) {
      await new Promise<void>(resolve => { discoverySocket.close(() => resolve()) })
    }
    const server = this.server
    this.server = undefined
    if (server !== undefined && server.listening) {
      server.closeAllConnections()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
    await accountClose
    this.activeRequests.clear()
    this.activeWebSockets.clear()
    this.connectedSockets.clear()
    this.policy = undefined
    this.listenerPort = undefined
  }

  /** Safe metadata helper for direct loopback integrations. */
  tokens(): readonly AccountTokenSummary[] {
    return this.account.listTokens()
  }

  /** Status shown by the loopback mobile-access control card. */
  extensionStatus(): { readonly loaded: number; readonly failed: number } {
    return this.extensions?.status() ?? { loaded: 0, failed: 0 }
  }
}
