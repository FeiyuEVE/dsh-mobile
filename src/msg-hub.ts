/**
 * msg-hub 的**只读**转发面（工单 #363，Q2 方案 A）。
 *
 * 手机只能到 18443 网关；msg-hub 的 `GET /v1/*` 只回环/内网（`127.0.0.1:8787`），
 * 手机直连不到。本模块把**五个只读端点**经网关转出去，规则写死在这里，网关只做
 * 装配：
 *
 * - 白名单只有五条：`/healthz`、`/v1/targets`、`/v1/messages`、
 *   `/v1/messages/{id}`、`/v1/stats`；其余路径一律 404，**不转发**。
 * - 任何写方法（POST / PUT / PATCH / DELETE …）一律 405，**连上游连接都不建**
 *   ——「没转发」本身是判据（对面读写不产生新行），只贴 405 不算。
 * - 上游凭据（msg-hub `X-Service-Token`）**只留在网关侧**；客户端的
 *   `Authorization` / cookie / CSRF 头一律不复制到上游，上游请求头集合由
 *   {@link buildUpstreamHeaders} 决定，日志按 {@link describeHeaders} 脱敏后输出。
 * - 显式超时由配置给（`msgHubTimeoutMs`，默认 3000ms，上限 3000ms，符合
 *   「≤3s」）；不可达 / 超时 / 上游 401、403 / 上游 5xx **不透传**，统一回
 *   {@link MSG_HUB_DEGRADED_MESSAGE} 这段可判错误（方案段 D2 的逐字文案），
 *   由客户端原样显示——不再出现「把对方 403 当成用户没权限」。
 */

import { readFile, stat } from 'node:fs/promises'
import { request as requestHttp, type IncomingHttpHeaders } from 'node:http'

/** 网关侧的只读转发前缀（手机侧路径）。 */
export const MSG_HUB_PREFIX = '/api/msg-hub'

/**
 * 方案段 D2 的**逐字**降级文案（#342 `docs/design/redesign-342-field-map.md` §二 D2）。
 *
 * 网关把它作为不可读时的 `message` 返回，客户端直接显示，不再自己拼文案。
 */
export const MSG_HUB_DEGRADED_MESSAGE = '本端暂不可读（通道未定）'

/** msg-hub 认的服务令牌头（`src/http/auth.rs` 的 `X-Service-Token`）。 */
export const MSG_HUB_TOKEN_HEADER = 'x-service-token'

/** 单个只读响应的字节上限：超过按「上游不可读」处理，不把网关内存喂爆。 */
export const MSG_HUB_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/u

/** 手机侧路径是否落在只读转发前缀里（含前缀本身，用于回 404 而不是透传）。 */
export function isMsgHubPath(pathname: string): boolean {
  return pathname === MSG_HUB_PREFIX || pathname.startsWith(`${MSG_HUB_PREFIX}/`)
}

/**
 * 手机侧路径 → 上游 msg-hub 路径。白名单外的返回 `undefined`（调用方回 404）。
 *
 * 只做**形状**判断（段数 + 字符集），不解析业务 id：`/v1/messages/{id}` 的 id 由
 * msg-hub 自己判，网关不替它猜。
 */
export function resolveMsgHubUpstreamPath(pathname: string): string | undefined {
  if (!isMsgHubPath(pathname)) return undefined
  const suffix = pathname.slice(MSG_HUB_PREFIX.length)
  if (suffix === '/healthz') return '/healthz'
  if (suffix === '/v1/targets') return '/v1/targets'
  if (suffix === '/v1/messages') return '/v1/messages'
  if (suffix === '/v1/stats') return '/v1/stats'
  const message = /^\/v1\/messages\/([^/]+)$/u.exec(suffix)
  if (message !== null) {
    const id = message[1] ?? ''
    if (MESSAGE_ID.test(id)) return `/v1/messages/${id}`
  }
  return undefined
}

/** 只有这五个方法名算读；其余（含 TRACE 之外的自定义方法）一律 405。 */
export function isMsgHubReadMethod(method: string | undefined): boolean {
  return method === 'GET' || method === 'HEAD'
}

/**
 * 转发到上游时**唯一**允许的请求头集合。
 *
 * 客户端带来的 `Authorization` / `Cookie` / `x-dsh-mobile-csrf` / `Host` 等一律
 * 不进上游：上游只认网关这一枚服务令牌（`MSG_HUB_TOKEN_HEADER`），这就是判据 3
 * 「令牌留网关侧、手机只拿网关自己的鉴权」的代码落点。
 */
export function buildUpstreamHeaders(token: string): Record<string, string> {
  return {
    [MSG_HUB_TOKEN_HEADER]: token,
    accept: 'application/json',
    'user-agent': 'dsh-mobile-gateway/msg-hub-read-only',
  }
}

/**
 * 脱敏后的请求头清单（日志与证据用）。
 *
 * 令牌头只暴露「存在 + 长度」，其余头原样列出——这样 `curl` 侧能核「上游只收到
 * 这几个头」，且日志里不落凭据。
 */
export function describeHeaders(headers: Record<string, string>): string {
  const parts: string[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === MSG_HUB_TOKEN_HEADER) {
      parts.push(`${name}=<redacted:${String(value.length)}>`)
    } else {
      parts.push(`${name}=${value}`)
    }
  }
  return parts.join(',')
}

/** 上游读失败的三类可判结果（都映射成 {@link MSG_HUB_DEGRADED_MESSAGE}）。 */
export type MsgHubFailure =
  | { readonly kind: 'unconfigured' }
  | { readonly kind: 'unreachable'; readonly detail: string }
  | { readonly kind: 'upstream_rejected'; readonly status: number }
  | { readonly kind: 'upstream_error'; readonly status: number }
  | { readonly kind: 'response_too_large' }

export interface MsgHubReply {
  readonly status: number
  readonly contentType: string
  readonly body: Buffer
}

/** 网关侧读取上游令牌：内联值优先，其次文件（按 mtime 缓存 5s，轮换不必重启）。 */
export class MsgHubTokenReader {
  private cached: { readonly mtimeMs: number; readonly token: string } | undefined

  constructor(private readonly inlineToken: string | undefined, private readonly tokenFile: string | undefined) {}

  async read(): Promise<string | undefined> {
    if (this.inlineToken !== undefined && this.inlineToken !== '') return this.inlineToken
    if (this.tokenFile === undefined) return undefined
    try {
      const info = await stat(this.tokenFile)
      if (this.cached !== undefined && this.cached.mtimeMs === info.mtimeMs) return this.cached.token
      const token = (await readFile(this.tokenFile, 'utf8')).trim()
      if (token === '') return undefined
      this.cached = { mtimeMs: info.mtimeMs, token }
      return token
    } catch {
      return undefined
    }
  }
}

/**
 * 发一条只读 GET 到上游。
 *
 * 超时用**显式** `setTimeout`（配置值 ≤3000ms）+ destroy：Node 的默认 socket 超时是
 * 无限的，靠它等于没有超时。响应体按 {@link MSG_HUB_MAX_RESPONSE_BYTES} 截断判定。
 */
export async function forwardMsgHubRead(options: {
  readonly origin: URL
  readonly token: string
  readonly timeoutMs: number
  readonly upstreamPath: string
  readonly search: string
}): Promise<MsgHubReply | MsgHubFailure> {
  const headers = buildUpstreamHeaders(options.token)
  return await new Promise<MsgHubReply | MsgHubFailure>((resolve) => {
    let settled = false
    const finish = (value: MsgHubReply | MsgHubFailure): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const upstream = requestHttp({
      protocol: options.origin.protocol,
      host: options.origin.hostname,
      port: options.origin.port,
      method: 'GET',
      path: `${options.upstreamPath}${options.search}`,
      headers,
    }, (incoming) => {
      const status = incoming.statusCode ?? 502
      if (status === 401 || status === 403) {
        incoming.resume()
        finish({ kind: 'upstream_rejected', status })
        return
      }
      if (status >= 500) {
        incoming.resume()
        finish({ kind: 'upstream_error', status })
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      incoming.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > MSG_HUB_MAX_RESPONSE_BYTES) {
          incoming.destroy()
          finish({ kind: 'response_too_large' })
          return
        }
        chunks.push(chunk)
      })
      incoming.on('end', () => {
        finish({
          status,
          contentType: contentTypeOf(incoming.headers),
          body: Buffer.concat(chunks),
        })
      })
      incoming.on('error', (error: Error) => finish({ kind: 'unreachable', detail: error.message }))
    })
    upstream.setTimeout(options.timeoutMs, () => {
      upstream.destroy(new Error(`msg-hub 超时（${String(options.timeoutMs)}ms）`))
    })
    upstream.on('error', (error: Error) => finish({ kind: 'unreachable', detail: error.message }))
    upstream.end()
  })
}

function contentTypeOf(headers: IncomingHttpHeaders): string {
  const value = headers['content-type']
  return typeof value === 'string' && value !== '' ? value : 'application/json'
}
