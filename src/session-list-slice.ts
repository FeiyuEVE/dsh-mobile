/**
 * `POST /api/session/list` 的网关侧服务端切片（工单 #229）。
 *
 * 宿主（`dsh-api-session-controller`）的 `list(_request, signal)` **完全未读**
 * `_request`，一次总是回全部可见会话（线上实测 3905 条 / 5.3 MB / 解码后
 * 对象图 ≈31 MB）。改宿主必须重启 dsh-web，而硬约束禁止重启；于是分页落在
 * 网关这一层：同一个请求体里的 `payload.args._request.limit` 是**唯一的开关**。
 *
 * 三条不可退让的边界：
 * 1. **opt-in**：`_request.limit` 不存在时一律原样透传，回包字节与 0.3.49
 *    完全一致（已发布 build 181 的 App 还不认识 `nextCursor`）。
 * 2. **只裁条、不改字段**：`items` 里的对象原样保留（不删字段、不改值），
 *    只在承载 `items` 的那个对象上追加 `nextCursor`。
 * 3. **绝不静默**：非法 `limit` / `cursor` 回 400 + 可读 `message`；超缓冲上限
 *    直接透传并写一条带 `session-list-slice` 的诊断日志。
 *
 * 游标语义与宿主终局契约同名：`base64url(JSON([updatedAt, sessionId]))`，
 * 排序键 `updatedAt desc, sessionId asc`（keyset）。将来宿主自己实现
 * `limit/cursor/nextCursor` 后，网关这段可以退化为纯透传，App 零改动。
 */
export const SESSION_LIST_PATH = '/api/session/list'

/** 协议硬上限：即使配置把单页放到最大，也不允许超过 100。 */
export const SESSION_LIST_LIMIT_MAX = 100
/** 单页默认值：仅在配置未给出 `sessionListPageSize` 时使用。 */
export const SESSION_LIST_DEFAULT_PAGE_SIZE = 20
/** 全量回包缓冲上限（实测全量 5.3 MB，32 MiB 留足 6 倍余量）。 */
export const SESSION_LIST_MAX_BUFFER_BYTES = 32 * 1024 * 1024
/** 全量结果短期缓存默认 TTL；0 = 关闭。 */
export const SESSION_LIST_DEFAULT_CACHE_MS = 30_000
/** 缓存 TTL 配置上限（1 小时）：再长就只是「让列表变旧」，不是省一次 3.5s。 */
export const SESSION_LIST_CACHE_MAX_MS = 60 * 60_000

/** 一条会话的排序键。`updatedAt` 是宿主 `summaryFor` 的毫秒时间戳。 */
export interface SessionListCursor {
  readonly updatedAt: number
  readonly sessionId: string
}

/** 已通过校验的切片请求（limit 一定合法，cursor 已解码）。 */
export interface SessionListPageRequest {
  readonly limit: number
  readonly cursor?: SessionListCursor
  /** 当前请求的 rpcId（缓存命中时必须把它写回信封，否则客户端判 rpcId mismatch）。 */
  readonly rpcId?: string
  /**
   * 客户端原始 `cursor` 串（规范化之前）。只用于可诊断日志：分页参数面
   * 必须能按 App 实际发出的值归因，解码后的对象不能替代它。
   */
  readonly cursorText?: string
}

/** 请求体分类：透传 / 400 / 切片。 */
export type SessionListRequestPlan =
  | { readonly kind: 'passthrough' }
  | {
    readonly kind: 'invalid'
    readonly error: 'invalid_limit' | 'invalid_cursor'
    readonly message: string
    /** 非法请求的原始参数（日志归因用；非字符串值用 JSON 文本）。 */
    readonly rawLimit?: string
    readonly rawCursor?: string
  }
  | ({ readonly kind: 'page' } & SessionListPageRequest)

/** 一条合法会话条目（只取排序与游标需要的两个字段）。 */
export interface SessionListEntry {
  readonly sessionId: string
  readonly updatedAt: number
}

/** 解析出的回包文档：`root` 是整棵 JSON，`holder` 是挂 `items` 的那层对象。 */
export interface SessionListDocument {
  readonly root: Record<string, unknown>
  readonly holder: Record<string, unknown>
  readonly items: readonly unknown[]
}

const BASE64URL = /^[A-Za-z0-9_-]+$/u

/** 人类可读的 400 原因（App 侧可原样展示，不必猜）。 */
export const SESSION_LIST_ERROR_MESSAGES = Object.freeze({
  invalid_limit: (maximum: number): string => `limit 必须是 1 到 ${String(maximum)} 之间的整数`,
  invalid_cursor: 'cursor 必须是网关下发的 nextCursor（base64url(JSON([updatedAt, sessionId]))）',
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解析请求体，决定「原样透传 / 400 / 切片」。
 *
 * **只有** `payload.args._request` 这个对象里**出现 `limit` 键**才进入分页分支：
 * - 键不存在 → 透传（包括完全不带 `_request` 的 build 181 请求）；
 * - 键存在但值不是 1..maximum 的整数 → 400 `invalid_limit`（不静默截断）；
 * - 键合法但 `cursor` 不是字符串 / 解码失败 → 400 `invalid_cursor`。
 *
 * 请求体不是 JSON / 没有 `payload.args` 时一律透传：网关无权改写自己看不懂的
 * 请求，交给上游按原样处理（与 0.3.49 行为一致）。
 */
export function planSessionListRequest(body: Buffer, maximum: number): SessionListRequestPlan {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown
  } catch {
    return { kind: 'passthrough' }
  }
  if (!isRecord(parsed) || !isRecord(parsed.payload) || !isRecord(parsed.payload.args)) {
    return { kind: 'passthrough' }
  }
  const request = parsed.payload.args._request
  if (!isRecord(request) || !Object.hasOwn(request, 'limit')) return { kind: 'passthrough' }
  const rpcId = typeof parsed.rpcId === 'string' ? parsed.rpcId : undefined

  const limit: unknown = request.limit
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    return {
      kind: 'invalid',
      error: 'invalid_limit',
      message: SESSION_LIST_ERROR_MESSAGES.invalid_limit(maximum),
      rawLimit: rawLogValue(limit),
    }
  }

  const rawCursor: unknown = request.cursor
  if (rawCursor === undefined) return { kind: 'page', limit, ...(rpcId === undefined ? {} : { rpcId }) }
  if (typeof rawCursor !== 'string') {
    return {
      kind: 'invalid',
      error: 'invalid_cursor',
      message: SESSION_LIST_ERROR_MESSAGES.invalid_cursor,
      rawLimit: String(limit),
      rawCursor: rawLogValue(rawCursor),
    }
  }
  try {
    return {
      kind: 'page',
      limit,
      cursor: decodeSessionListCursor(rawCursor),
      cursorText: rawCursor,
      ...(rpcId === undefined ? {} : { rpcId }),
    }
  } catch {
    return {
      kind: 'invalid',
      error: 'invalid_cursor',
      message: SESSION_LIST_ERROR_MESSAGES.invalid_cursor,
      rawLimit: String(limit),
      rawCursor,
    }
  }
}

/** 非法参数值的日志文本：字符串原样，其它值用 JSON（含 undefined 的兜底）。 */
function rawLogValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * 解码 keyset 游标。规范化校验与 ACP 的 `decodeSessionListCursor` 同口径：
 * 只接受 `base64url(JSON([updatedAt, sessionId]))` 的**规范**编码——重新编码
 * 必须逐字节相等，否则同一位置的多种写法都能混进来（缓存/去重会失真）。
 */
export function decodeSessionListCursor(value: string): SessionListCursor {
  if (!BASE64URL.test(value)) throw new Error('cursor must be base64url')
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new Error('cursor is not valid JSON')
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) throw new Error('cursor must be a two-element array')
  const [updatedAt, sessionId] = decoded as [unknown, unknown]
  if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new Error('cursor updatedAt is invalid')
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('cursor sessionId is invalid')
  const canonical = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
  if (canonical !== value) throw new Error('cursor is not canonical')
  return { updatedAt, sessionId }
}

/** 编码下一页游标（取本页最后一条的排序键）。 */
export function encodeSessionListCursor(entry: SessionListCursor): string {
  return Buffer.from(JSON.stringify([entry.updatedAt, entry.sessionId]), 'utf8').toString('base64url')
}

/** `updatedAt desc, sessionId asc`；id 按 UTF-8 字节比较，不受进程 locale 影响。 */
export function compareSessionListEntries(left: SessionListEntry, right: SessionListEntry): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  return Buffer.compare(Buffer.from(left.sessionId, 'utf8'), Buffer.from(right.sessionId, 'utf8'))
}

/** 判断条目的排序键是否严格位于游标之后（下一页的起点）。 */
export function isAfterSessionListCursor(entry: SessionListEntry, cursor: SessionListCursor): boolean {
  return entry.updatedAt < cursor.updatedAt
    || (entry.updatedAt === cursor.updatedAt
      && Buffer.compare(Buffer.from(entry.sessionId, 'utf8'), Buffer.from(cursor.sessionId, 'utf8')) > 0)
}

/**
 * 从 `items` 里抽出排序键。任一条目缺 `sessionId` / `updatedAt` 就返回
 * `undefined`——调用方据此**整单透传**，绝不把「看不懂的条目」悄悄丢掉：
 * 那会违反「items 内每个字段原样保留」。
 */
export function readSessionListEntries(items: readonly unknown[]): SessionListEntry[] | undefined {
  const entries: SessionListEntry[] = []
  for (const item of items) {
    if (!isRecord(item) || typeof item.sessionId !== 'string' || item.sessionId.length === 0) return undefined
    const updatedAt: unknown = item.updatedAt
    if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 0) return undefined
    entries.push({ sessionId: item.sessionId, updatedAt })
  }
  return entries
}

/** 定位承载 `items` 的对象：兼容 RPC 信封与裸 `{items}` 两种回包。 */
export function locateSessionListDocument(parsed: unknown): SessionListDocument | undefined {
  if (!isRecord(parsed)) return undefined
  const result = parsed.result
  if (isRecord(result) && result.ok === true && isRecord(result.value) && Array.isArray(result.value.items)) {
    return { root: parsed, holder: result.value, items: result.value.items }
  }
  if (Array.isArray(parsed.items)) return { root: parsed, holder: parsed, items: parsed.items }
  return undefined
}

/**
 * 按 keyset 切一页。返回的对象引用与上游 `items` 里的元素**同一引用**，
 * 只做重新排序与截取；`nextCursor` 仅在本页之后还有条目时给出。
 */
export function sliceSessionListItems(
  items: readonly unknown[],
  entries: readonly SessionListEntry[],
  limit: number,
  cursor: SessionListCursor | undefined,
): { readonly items: unknown[]; readonly nextCursor?: string } {
  const order = entries.map((_entry, index) => index)
    .sort((left, right) => compareSessionListEntries(entries[left]!, entries[right]!))
  const remaining = cursor === undefined
    ? order
    : order.filter(index => isAfterSessionListCursor(entries[index]!, cursor))
  const page = remaining.slice(0, limit)
  const last = page.at(-1)
  const nextCursor = remaining.length > page.length && last !== undefined
    ? encodeSessionListCursor(entries[last]!)
    : undefined
  return {
    items: page.map(index => items[index]!),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  }
}

/**
 * 在承载 `items` 的对象上写回当页并序列化整棵文档。
 * 其它顶层字段（`type` / `rpcId` / `result` …）一律原样保留；
 * 上游若已有 `nextCursor`，只有「确实还有下一页」时才保留/覆盖它。
 */
export function buildSessionListResponse(
  document: SessionListDocument,
  items: readonly unknown[],
  nextCursor: string | undefined,
  rpcId?: string,
): Buffer {
  // 缓存里存的是**上一次请求**的全量回包；同一个信封原样返回会让客户端
  // 按 rpcId 校验失败。命中缓存时用当前请求的 rpcId 覆盖。
  if (rpcId !== undefined && typeof document.root.rpcId === 'string') document.root.rpcId = rpcId
  document.holder.items = items
  if (nextCursor === undefined) delete document.holder.nextCursor
  else document.holder.nextCursor = nextCursor
  return Buffer.from(JSON.stringify(document.root), 'utf8')
}

/** 全量结果缓存：单条、按授权身份隔离、固定 TTL。 */
export class SessionListCache {
  private entry: { readonly sessionKey: string; readonly body: Buffer; readonly expiresAt: number } | undefined

  constructor(
    private readonly ttlMs: number,
    private readonly maxBytes: number = SESSION_LIST_MAX_BUFFER_BYTES,
  ) {}

  /** 命中返回缓存的全量回包字节；未命中 / 过期 / 身份不符都返回 `undefined`。 */
  get(sessionKey: string, now: number): Buffer | undefined {
    if (this.ttlMs <= 0 || this.entry === undefined) return undefined
    if (this.entry.expiresAt <= now || this.entry.sessionKey !== sessionKey) {
      this.entry = undefined
      return undefined
    }
    return this.entry.body
  }

  /** 只缓存未超上限的全量回包；TTL 关闭时是空操作。 */
  set(sessionKey: string, body: Buffer, now: number): void {
    if (this.ttlMs <= 0 || body.byteLength > this.maxBytes) return
    this.entry = { sessionKey, body, expiresAt: now + this.ttlMs }
  }

  clear(): void {
    this.entry = undefined
  }
}
