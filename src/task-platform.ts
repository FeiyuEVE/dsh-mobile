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
 * 4. **令牌值不进日志**：调用方只记 `method / path / injected`；令牌文件路径也不进日志。
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
