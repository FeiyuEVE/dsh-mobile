/**
 * msg-hub **定时消息**的网关代理：`/api/msg-hub/*` → `<msgHubOrigin>/v1/*`。
 *
 * ## 为什么在移动网关里做
 *
 * msg-hub 只听回环 `127.0.0.1:8787`，鉴权只认 `x-service-token`（service / operator
 * 主体）。App 带的是网关账密换来的 30 天 token，既连不到 hub，也**绝不能**拿到
 * hub 的服务令牌（APK 可在局域网下载，`strings` 就能捞出来）。所以这一跳收在网关
 * 内部：客户端只认 `/api/msg-hub/*`，令牌每次请求从宿主文件现读、只写进上游头。
 *
 * ## 白名单（只开两条，别扩）
 *
 * - `GET|HEAD /api/msg-hub/v1/schedules` → `<hub>/v1/schedules`（query 只放
 *   `enabled` / `creator` / `limit` / `cursor`）；
 * - `POST /api/msg-hub/v1/schedules/{id}/cancel` → `<hub>/v1/schedules/{id}/cancel`
 *   （**不转发请求体**）。
 *
 * 其余一律不转发：`POST /v1/schedules`（新建）、`PATCH /v1/schedules/{id}`
 * （启停）、`POST /v1/broadcasts` 等**都不在白名单**里，分别得到 405 或 404。
 * 「新建提醒」留给后续单，因为那需要一套表单契约（selector / expr / 时区校验），
 * 不在本页的只读 + 取消范围内。
 *
 * ## 四条硬约束（改这里前先读）
 *
 * 1. **鉴权在转发之前**：先 `authorize`，未登录 / 被踢 / 过期 → 401，一个字节都
 *    不发往 hub；之后才判路由与方法。
 * 2. **客户端身份头一律不进上游**：`x-service-token` / `x-dsh-session-id` /
 *    `x-codex-thread-id` / `x-dsh-actor-type` 连放行列表都进不来，这里再显式删一遍。
 * 3. **令牌只写路径**：配置项 `msgHubServiceTokenFile` 指文件，不写值；每请求现读
 *    （轮换无需重载插件），省略 / 空文件 = 不注入（hub 自己回 401）。
 * 4. **令牌值不进日志**：只记方法 / 路径（query 里的 `creator` 脱敏）/ 是否注入 /
 *    上游状态 / 耗时 / 结局；令牌值、令牌文件路径与 hub 地址都不出现。
 *
 * 不新增服务、不新增端口：挂的是已有 18443/18452 网关上的一个前缀。
 */
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'

/** 转发前缀（剥掉后接 hub 的 `/v1/*`）。 */
export const MSG_HUB_PREFIX = '/api/msg-hub'

/** 上游超时：定时任务列表是本地 SQLite 查询，15s 足够且不拖住网关。 */
export const MSG_HUB_TIMEOUT_MS = 15_000

/** 客户端不得自带的 hub 身份头——上游身份**只**由网关构造。 */
export const MSG_HUB_CLIENT_IDENTITY_HEADERS = [
  'x-service-token',
  'x-dsh-session-id',
  'x-codex-thread-id',
  'x-dsh-actor-type',
] as const

/** 客户端头里可以转发的白名单（其余一律不转发）。 */
const FORWARDED_CLIENT_HEADERS = ['accept', 'accept-language', 'user-agent'] as const

/** 列表路由允许透传的 query 键（hub 只认这四个）。 */
const LIST_QUERY_KEYS = new Set(['enabled', 'creator', 'limit', 'cursor'])

/** 该路径是否属于 msg-hub 前缀（前缀本身也算：它会得到 404 route_denied）。 */
export function isMsgHubPath(decodedPathname: string): boolean {
  return decodedPathname === MSG_HUB_PREFIX || decodedPathname.startsWith(`${MSG_HUB_PREFIX}/`)
}

/** 白名单里的两条路由。 */
export type MsgHubRoute =
  | { readonly kind: 'list' }
  | { readonly kind: 'cancel'; readonly id: number }

export type MsgHubRouteDecision =
  | { readonly ok: true; readonly route: MsgHubRoute }
  | { readonly ok: false; readonly error: 'route_denied' | 'method_not_allowed' }

const SCHEDULES_PATH = '/v1/schedules'
const CANCEL_PATH = /^\/v1\/schedules\/(\d{1,19})\/cancel$/u

/** 路由 + 方法白名单：只有这两条会返回 `ok`。 */
export function matchMsgHubRoute(
  decodedPathname: string,
  method: string | undefined,
): MsgHubRouteDecision {
  if (!decodedPathname.startsWith(MSG_HUB_PREFIX)) {
    return { ok: false, error: 'route_denied' }
  }
  const suffix = decodedPathname.slice(MSG_HUB_PREFIX.length)
  if (suffix === SCHEDULES_PATH) {
    return method === 'GET' || method === 'HEAD'
      ? { ok: true, route: { kind: 'list' } }
      : { ok: false, error: 'method_not_allowed' }
  }
  const cancel = CANCEL_PATH.exec(suffix)
  if (cancel !== null) {
    if (method !== 'POST') return { ok: false, error: 'method_not_allowed' }
    const id = Number(cancel[1])
    if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: 'route_denied' }
    return { ok: true, route: { kind: 'cancel', id } }
  }
  return { ok: false, error: 'route_denied' }
}

/** 上游请求路径（列表可带已过滤的 query，取消不带）。 */
export function msgHubUpstreamPath(route: MsgHubRoute, filteredQuery = ''): string {
  if (route.kind === 'cancel') return `/v1/schedules/${String(route.id)}/cancel`
  return `/v1/schedules${filteredQuery}`
}

/**
 * 只保留白名单 query 键；值长度上限 256 字节，原始编码不动。
 *
 * 返回带 `?` 的串（没有合法参数时是空串）。顺序按入参，便于日志对照。
 */
export function filterScheduleQuery(search: string): string {
  if (search === '') return ''
  const kept: string[] = []
  for (const pair of search.replace(/^\?/u, '').split('&')) {
    if (pair === '') continue
    const index = pair.indexOf('=')
    const rawName = index < 0 ? pair : pair.slice(0, index)
    const rawValue = index < 0 ? '' : pair.slice(index + 1)
    if (hasBrokenPercent(rawName) || hasBrokenPercent(rawValue)) continue
    let name = rawName
    try {
      name = decodeURIComponent(rawName)
    } catch {
      continue
    }
    if (!LIST_QUERY_KEYS.has(name)) continue
    if (rawValue.length > 256) continue
    kept.push(`${rawName}=${rawValue}`)
  }
  return kept.length === 0 ? '' : `?${kept.join('&')}`
}

/** 百分号编码里出现不完整的 `%X` / `%XY` 就算坏值（过滤掉，不透传）。 */
function hasBrokenPercent(raw: string): boolean {
  return /%(?![0-9a-fA-F]{2})/u.test(raw)
}

export interface MsgHubUpstreamHeadersOptions {
  /** 网关回环 authority（`127.0.0.1:8787`）。 */
  readonly upstreamHost: string
  /** 从配置路径读出的服务令牌；空 / 缺失 = 不注入（hub 按匿名拒绝）。 */
  readonly serviceToken?: string
  readonly clientHeaders?: IncomingHttpHeaders
}

/**
 * 构造上游请求头：只放行一小撮客户端头，显式剔除 hub 身份头，再补服务令牌。
 *
 * 调用点已经过路由白名单，所以这里只要拿到令牌就注入；`injected` 只给日志用，
 * **不携带令牌值**。
 */
export function msgHubUpstreamHeaders(
  options: MsgHubUpstreamHeadersOptions,
): { headers: OutgoingHttpHeaders; injected: boolean } {
  const headers: OutgoingHttpHeaders = { host: options.upstreamHost }
  for (const name of FORWARDED_CLIENT_HEADERS) {
    const value = options.clientHeaders?.[name]
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  // 放行列表之外的头本来就不会转发；这里再显式删一遍，作为「放行列表日后被改宽」时的最后一道闸。
  for (const name of MSG_HUB_CLIENT_IDENTITY_HEADERS) delete headers[name]
  const token = options.serviceToken?.trim() ?? ''
  const injected = token !== ''
  if (injected) headers['x-service-token'] = token
  return { headers, injected }
}

/**
 * 一次 msg-hub 请求的**结局词表**。
 *
 * - `ok`：上游 2xx/3xx；
 * - `upstream_rejected`：上游 4xx/5xx（注入了令牌但仍被拒，与网关自己拒分开）；
 * - `upstream_unreachable`：连不上 / 超时；
 * - `unauthorized`：网关自己拒（未登录 / 被踢 / 过期），一个字节都没发往上游；
 * - `method_not_allowed`：白名单路径上的非白名单方法（405，不转发）；
 * - `route_denied`：前缀下的非白名单路径（404，不转发）。
 */
export type MsgHubOutcome =
  | 'ok'
  | 'upstream_rejected'
  | 'upstream_unreachable'
  | 'unauthorized'
  | 'method_not_allowed'
  | 'route_denied'

export interface MsgHubLogFields {
  readonly method: string
  /** 编码后的 pathname + 已过滤/脱敏的 query。 */
  readonly path: string
  readonly injected: boolean
  readonly upstreamStatus?: number
  /** 上游不可达 / 超时的原因类别（仅错误码，**绝不带地址与令牌**）。 */
  readonly upstreamError?: string
  readonly durationMs: number
  /** 客户端自带、已被剔除的 hub 身份头数量。 */
  readonly clientIdentityHeadersStripped: number
  readonly outcome: MsgHubOutcome
}

/**
 * 日志里的 query：只留白名单键，并把 `creator` 的值换成 `<redacted:长度>`。
 *
 * `creator` 是 `session:<id>` —— 会话标识不该进网关日志；其余键（`enabled` /
 * `limit` / `cursor`）是纯枚举与分页，保留才好比对。
 */
export function redactMsgHubQuery(search: string): string {
  const filtered = filterScheduleQuery(search)
  if (filtered === '') return ''
  return filtered.replace(/([?&])creator=([^&#]*)/gu, (_whole, lead: string, rawValue: string) => {
    let value = rawValue
    try {
      value = decodeURIComponent(rawValue)
    } catch {
      /* 非法编码就按原样计长 */
    }
    return `${lead}creator=<redacted:${String(value.length)}>`
  })
}

/** 客户端自带的 hub 身份头数量（证明伪造头确实被剔除）。 */
export function countMsgHubIdentityHeaders(headers: IncomingHttpHeaders | undefined): number {
  let count = 0
  for (const name of MSG_HUB_CLIENT_IDENTITY_HEADERS) if (headers?.[name] !== undefined) count += 1
  return count
}

/**
 * 上游失败原因类别：只取错误码（`ECONNREFUSED` 等）或固定词 `timeout`，
 * **绝不回显 message**——Node 的 connect 错误 message 里带 `host:port`。
 */
export function classifyMsgHubUpstreamError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (typeof code === 'string' && /^[A-Z0-9_]+$/u.test(code)) return code
  if (error instanceof Error && error.message === 'msg_hub_timeout') return 'timeout'
  return 'request_failed'
}

/** 拼一行 `[msg-hub]` 结构化日志（单行、无空值字段、字段顺序固定）。 */
export function formatMsgHubLog(fields: MsgHubLogFields): string {
  const status = fields.upstreamStatus === undefined ? 'none' : String(fields.upstreamStatus)
  const parts = [
    '[msg-hub]',
    `method=${fields.method}`,
    `path=${fields.path}`,
    `injected=${String(fields.injected)}`,
    `upstream_status=${status}`,
    ...(fields.upstreamError === undefined ? [] : [`upstream_error=${fields.upstreamError}`]),
    `duration_ms=${String(Math.max(0, Math.round(fields.durationMs)))}`,
    `client_identity_headers_stripped=${String(fields.clientIdentityHeadersStripped)}`,
    `outcome=${fields.outcome}`,
  ]
  return parts.join(' ')
}
