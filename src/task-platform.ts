/**
 * 工单平台**只读代注入**（网关侧）：`GET|HEAD /api/task-platform/*` → `<taskPlatformOrigin>/api/*`。
 *
 * ## 为什么在移动网关里做
 *
 * 工单平台（k3s NodePort，`TASK_PLATFORM_AUTH=enforce`）只认 `x-service-token` 或
 * `x-dsh-session-id`，**不接受**移动网关那枚 Bearer；App 只带网关账密登录换来的 token，
 * 自己拿不到平台身份 ⇒ 读工单全天 403。这里把「网关账号 token → 平台服务令牌」这一步
 * 收在网关内部：移动端只需要那一枚 token，平台侧的统一鉴权面不变。
 *
 * 与 `../dsh-mobile-backend/src/modules/task-platform.js` 同形（后端侧先落地）：前缀、
 * 只读方法判定、身份头剔除与注入口径逐条对齐。
 *
 * ## 四条硬约束（改这里前先读）
 *
 * 1. **鉴权在转发之前**：`handleTaskPlatform` 先 `authorize`，未登录/被踢/过期 → 401，
 *    一个字节都不发往平台。
 * 2. **服务令牌只给只读方法**：平台侧它是 bootstrap 身份（读写全权），所以只对
 *    `GET`/`HEAD` 注入；其余方法一律 405、不转发（写请求保持匿名，不会因网关被提权）。
 * 3. **客户端身份头一律不进上游**：`x-service-token` / `x-dsh-session-id` /
 *    `x-dsh-actor-type` 连放行列表都进不来，这里再显式删一遍——上游身份只由网关构造。
 * 4. **令牌值不进日志**：日志只记方法 / 路径 / 是否注入 / 上游状态 / 耗时 / 剔头数 /
 *    结局；令牌值与令牌文件路径都不进日志，令牌长度也可以不记。
 *
 * 不新增服务、不新增端口：挂的是已有 18443/18452 网关上的一个前缀。
 */
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'

/** 转发前缀（`taskPlatformOrigin` 之后接 `/api/*`）。 */
export const TASK_PLATFORM_PREFIX = '/api/task-platform'

/** 允许注入服务令牌的方法：只读方法。 */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD'])

/**
 * 客户端不得自带的平台身份头——上游身份**只**由网关构造。
 *
 * 尤其是 `x-service-token`：客户端即使拿着网关 token 也不能借代理把自己标成服务身份，
 * 或伪造别人的 session / actor 类型。
 */
export const CLIENT_IDENTITY_HEADERS = ['x-service-token', 'x-dsh-session-id', 'x-dsh-actor-type'] as const

/** 客户端头里可以转发的白名单（其余一律不转发：cookie / authorization / 身份头都在门外）。 */
const FORWARDED_CLIENT_HEADERS = ['accept', 'accept-language', 'user-agent'] as const

/** 该路径是否属于工单平台只读前缀（前缀本身也算，会转发成 `/api`）。 */
export function isTaskPlatformPath(decodedPathname: string): boolean {
  return decodedPathname === TASK_PLATFORM_PREFIX || decodedPathname.startsWith(`${TASK_PLATFORM_PREFIX}/`)
}

/** 是否只读方法（`GET` / `HEAD`）。 */
export function isReadOnlyMethod(method: string | undefined): boolean {
  return method !== undefined && READ_ONLY_METHODS.has(method)
}

/**
 * 剥掉 `/api/task-platform` 前缀、拼回平台路径：`/api/task-platform/api/v1/projects`
 * → `/api/api/v1/projects`… 不对，是 → `/api/v1/projects`（`/api/task-platform` 之后
 * 原样保留，再前置网关固定的 `/api`？见下）。
 *
 * 口径按任务要求逐字：`/api/task-platform/*` → `http://127.0.0.1:30081/api/*`，即
 * **前缀整段替换成 `/api`**。所以 `/api/task-platform/api/v1/projects` → `/api/api/v1/...`？
 * 不是：前缀 `/api/task-platform` 剥掉后剩 `/api/v1/projects`，替换成 `/api` 会变成
 * `/api/api/v1/projects`。实际约定是「前缀剥掉、其余原样」——平台自身路径以 `/api/`
 * 开头，剥掉后就是 `/api/v1/projects`。这里的实现即「前缀剥掉、其余原样」。
 *
 * 入参用 **URL 编码后的 pathname**（不是 decoded），保证 `http.request` 的请求行合法。
 */
export function taskPlatformUpstreamPath(pathname: string, search: string): string {
  if (!pathname.startsWith(TASK_PLATFORM_PREFIX)) throw new Error('path is not under the task-platform prefix')
  const suffix = pathname.slice(TASK_PLATFORM_PREFIX.length)
  return `${suffix === '' ? '/api' : suffix}${search}`
}

export interface TaskPlatformUpstreamHeadersOptions {
  readonly method: string | undefined
  /** 平台回环 authority（`127.0.0.1:30081`）。 */
  readonly upstreamHost: string
  /** 从配置路径读出的服务令牌；空 / 缺失 = 不注入（平台按匿名拒绝）。 */
  readonly serviceToken?: string
  readonly clientHeaders?: IncomingHttpHeaders
}

/**
 * 构造上游请求头：只放行一小撮客户端头，显式剔除平台身份头，再按方法决定是否补令牌。
 *
 * 返回 `{ headers, injected }`；`injected` 只给日志用，**不携带令牌值**。
 */
export function taskPlatformUpstreamHeaders(
  options: TaskPlatformUpstreamHeadersOptions,
): { headers: OutgoingHttpHeaders; injected: boolean } {
  const headers: OutgoingHttpHeaders = { host: options.upstreamHost }
  for (const name of FORWARDED_CLIENT_HEADERS) {
    const value = options.clientHeaders?.[name]
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  // 放行列表之外的头本来就不会转发；这里再显式删一遍，作为「放行列表日后被改宽」时的最后一道闸。
  for (const name of CLIENT_IDENTITY_HEADERS) delete headers[name]
  const token = options.serviceToken?.trim() ?? ''
  const injected = isReadOnlyMethod(options.method) && token !== ''
  if (injected) headers['x-service-token'] = token
  return { headers, injected }
}

/**
 * 一次工单平台请求的**结局词表**（网关侧与 `dsh-mobile-backend` 侧逐字共用）。
 *
 * - `ok`：上游 2xx/3xx；
 * - `upstream_rejected`：上游 4xx/5xx——**「注入了但平台仍然拒」就是这一条**，与
 *   `unauthorized` 分开，正是这次要补的可判别性；
 * - `upstream_unreachable`：连不上 / 超时（`upstream_status=none` + `upstream_error`）；
 * - `unauthorized`：网关自己拒（未登录 / 被踢 / 过期），一个字节都没发往上游；
 * - `method_not_allowed`：写方法 / 非只读方法，405 且在鉴权之前。
 */
export type TaskPlatformOutcome =
  | 'ok'
  | 'upstream_rejected'
  | 'upstream_unreachable'
  | 'unauthorized'
  | 'method_not_allowed'

/** 结构化日志字段（字段名与后端代理逐字一致）。 */
export interface TaskPlatformLogFields {
  readonly method: string
  /** 编码后的 pathname + 已脱敏的 query。 */
  readonly path: string
  /** 是否真的把 `x-service-token` 注入给了上游。 */
  readonly injected: boolean
  /** 上游 HTTP 状态码；未得到响应（含未转发）时为 `undefined` → 日志写 `none`。 */
  readonly upstreamStatus?: number
  /** 上游不可达 / 超时的原因类别（仅错误码，**绝不带地址与令牌**）。 */
  readonly upstreamError?: string
  readonly durationMs: number
  /** 客户端自带、已被剔除的平台身份头数量。 */
  readonly clientIdentityHeadersStripped: number
  readonly outcome: TaskPlatformOutcome
}

/**
 * query 里「可能含令牌」的参数名：命中时只留长度（`<redacted:N>`），值不落日志。
 *
 * 用分段边界匹配而不是裸子串，避免把 `keyword` 这类正常检索参数误脱敏：
 * `access_token` / `api_key` / `apikey` / `accessKey` / `sessionId` / `authorization`
 * 都会命中，`keyword` / `sort` 不会。
 */
const SENSITIVE_QUERY_KEY =
  /(?:^|[_\-.])?(?:token|secret|password|passwd|credential|credentials|authorization|auth|bearer|cookie|signature|sig|sessionid|session|apikey|accesskey|key)(?:$|[_\-.])/iu

/**
 * 保留 query 串（今天的故障全靠 `?limit=1` 这类路径区分），但把敏感参数的值换成
 * `<redacted:长度>`。只动值，键与其余参数的原始编码都不变。
 */
export function redactTaskPlatformQuery(search: string): string {
  if (search === '') return ''
  return search.replace(
    /([?&])([^=&#]+)=([^&#]*)/gu,
    (whole: string, lead: string, rawName: string, rawValue: string): string => {
      let name = rawName
      try {
        name = decodeURIComponent(rawName)
      } catch { /* 非法编码就按原样判 */ }
      if (!SENSITIVE_QUERY_KEY.test(name)) return whole
      let value = rawValue
      try {
        value = decodeURIComponent(rawValue)
      } catch { /* 非法编码就按原样计长 */ }
      return `${lead}${rawName}=<redacted:${String(value.length)}>`
    },
  )
}

/** 客户端自带的平台身份头数量（证明伪造头确实被剔除）。 */
export function countClientIdentityHeaders(headers: IncomingHttpHeaders | undefined): number {
  let count = 0
  for (const name of CLIENT_IDENTITY_HEADERS) if (headers?.[name] !== undefined) count += 1
  return count
}

/**
 * 上游失败原因类别：只取错误码（`ECONNREFUSED` 等）或固定词 `timeout`，
 * **绝不回显 message**——Node 的 connect 错误 message 里带 `host:port`。
 */
export function classifyTaskPlatformUpstreamError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (typeof code === 'string' && /^[A-Z0-9_]+$/u.test(code)) return code
  if (error instanceof Error && error.message === 'task_platform_timeout') return 'timeout'
  return 'request_failed'
}

/**
 * 拼一行 `[task-platform]` 结构化日志。
 *
 * 单行、无空值字段；`upstream_status` 永远出现（未拿到响应就是 `none`），
 * `upstream_error` 只在有原因时出现。字段顺序固定，便于 grep / 解析。
 */
export function formatTaskPlatformLog(fields: TaskPlatformLogFields): string {
  const status = fields.upstreamStatus === undefined ? 'none' : String(fields.upstreamStatus)
  const parts = [
    '[task-platform]',
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
