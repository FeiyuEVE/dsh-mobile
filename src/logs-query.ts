import { HttpError } from './http-security.js'

/** 日志查询默认条数：与 0.3.48 之前一致（不带参数时 100 条）。 */
export const LOGS_DEFAULT_LIMIT = 100
/** 单页硬上限：与 0.3.48 之前一致（超过 200 此前是静默截断，现在返回 400）。 */
export const LOGS_MAX_LIMIT = 200
/**
 * Elasticsearch 默认 `index.max_result_window`：`from + size` 超过它时 ES 会 400。
 * 这里提前按同一口径拒绝，免得「翻到第 101 页」变成 502 且原因不可读。
 */
export const LOGS_MAX_RESULT_WINDOW = 10_000
/** 关键词长度上限：日志检索不是通用查询接口，防止把整段文本塞进 `match_phrase`。 */
export const LOGS_MAX_QUERY_LENGTH = 200

/** `since` 只认 ES date math 的「正整数 + 单位」，如 `15m` / `2h` / `7d`。 */
const SINCE_PATTERN = /^[1-9][0-9]{0,5}[smhdw]$/u
const INTEGER_PATTERN = /^[0-9]+$/u

/** 一条已通过校验的日志查询。 */
export interface LogsQuery {
  readonly limit: number
  readonly offset: number
  readonly since: string
  readonly levels: readonly string[]
  readonly q: string | undefined
}

/**
 * 参数非法时要随 `{ error }` 一起下发的人类可读原因（App 侧可原样展示）。
 * 键与 `HttpError.code` 同源：`plugin.ts` 的日志路由按这张表决定是否附带 `message`。
 */
export const LOGS_QUERY_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  invalid_limit: `limit 必须是 1 到 ${String(LOGS_MAX_LIMIT)} 之间的整数`,
  invalid_offset: 'offset 必须是不小于 0 的整数',
  invalid_since: 'since 必须形如 15m / 2h / 7d（1 到 6 位正整数 + s|m|h|d|w）',
  invalid_q: `q 不能超过 ${String(LOGS_MAX_QUERY_LENGTH)} 个字符`,
  offset_window_exceeded: `offset + limit 不能超过 ${String(LOGS_MAX_RESULT_WINDOW)}（Elasticsearch max_result_window）；请缩小 since / level / q 的范围，或改用更小的 offset`,
}

/**
 * 把 URL 查询参数解析成一条日志查询。
 *
 * 非法参数一律抛 400（**不静默回落到默认值**，也不静默返回空页）：
 * 负 offset / 非数字 limit / 非法 since / 超长 q 都是客户端错误，让 App 能
 * 直接把原因显示出来，而不是拿一个空列表猜「是不是没日志」。
 */
export function parseLogsQuery(params: URLSearchParams): LogsQuery {
  const rawLimit = params.get('limit')
  let limit = LOGS_DEFAULT_LIMIT
  if (rawLimit !== null) {
    if (!INTEGER_PATTERN.test(rawLimit)) throw new HttpError(400, 'invalid_limit')
    limit = Number(rawLimit)
    if (limit < 1 || limit > LOGS_MAX_LIMIT) throw new HttpError(400, 'invalid_limit')
  }

  const rawOffset = params.get('offset')
  let offset = 0
  if (rawOffset !== null) {
    if (!INTEGER_PATTERN.test(rawOffset)) throw new HttpError(400, 'invalid_offset')
    offset = Number(rawOffset)
    if (!Number.isSafeInteger(offset)) throw new HttpError(400, 'invalid_offset')
  }

  const since = params.get('since') ?? '2h'
  if (!SINCE_PATTERN.test(since)) throw new HttpError(400, 'invalid_since')

  const rawLevel = params.get('level') ?? ''
  const levels = rawLevel.split(',').map(s => s.trim()).filter(Boolean)

  const rawQuery = params.get('q')
  const q = rawQuery === null ? undefined : rawQuery.trim()
  if (q !== undefined && q.length > LOGS_MAX_QUERY_LENGTH) throw new HttpError(400, 'invalid_q')

  // ES 的硬边界，提前拒绝并说明原因；否则第 101 页起会变成 502 es_search_400。
  if (offset + limit > LOGS_MAX_RESULT_WINDOW) throw new HttpError(400, 'offset_window_exceeded')

  return { limit, offset, since, levels, q: q === '' ? undefined : q }
}

/**
 * 构造发给 ES 的 `_search` 请求体。
 *
 * 分页用 `from`（= offset）而不是 `search_after`：App 要显示总数并允许直接跳到
 * 第 N 页，`offset` 是无状态参数；`search_after` 需要把上一页的 sort 游标带回来，
 * 且无法任意跳页。代价是深分页受 `max_result_window` 限制，所以上面对
 * `offset + limit > 10000` 明确返回 400。
 *
 * 检索用 `match_phrase` 而不是 `simple_query_string`：关键词按**短语**匹配，
 * 不会被 `+`/`-`/`OR` 之类的查询语法改变语义，也不会因用户输入 `"`、`(` 之类
 * 直接得到 ES 400；`message` 的 mapping 是 `text`，标准分析器对英文按词切分，
 * 中文按字切分，短语匹配对两者都成立。例如 `q=codepush` 只会命中消息里含
 * `codepush` 这一短语的文档（大小写不敏感）。
 */
export function buildLogsSearchRequest(query: LogsQuery): Record<string, unknown> {
  const must: unknown[] = [{ range: { '@timestamp': { gte: `now-${query.since}` } } }]
  if (query.levels.length > 0) must.push({ terms: { level: query.levels } })
  if (query.q !== undefined) must.push({ match_phrase: { message: query.q } })
  return {
    from: query.offset,
    size: query.limit,
    track_total_hits: true,
    sort: [{ '@timestamp': { order: 'desc' } }],
    _source: ['@timestamp', 'level', 'message', 'tag', 'service', 'app_version', 'build'],
    query: { bool: { must } },
  }
}

/** ES `_search` 响应里本路由用到的字段子集。 */
export interface ElasticsearchLogsBody {
  readonly hits?: {
    readonly total?: number | { readonly value?: number; readonly relation?: string }
    readonly hits?: ReadonlyArray<{ readonly _source?: Record<string, unknown> }>
  }
}

/** 一页日志 + 真实命中总数。 */
export interface LogsPage {
  readonly logs: Array<Record<string, unknown>>
  readonly total: number
  readonly totalRelation: string
}

/**
 * 从 ES 响应里取 `hits.total`（真实命中总数，不是本页条数）与本页 `_source`。
 *
 * `track_total_hits: true` 保证 ES 7+ 返回 `{ value, relation: 'eq' }`；这里同时
 * 兼容 ES 6 的裸数字形态。真的没有 total 时把 relation 标成 `unknown`，
 * 而不是拿本页条数冒充总数。
 */
export function readLogsSearchResponse(doc: ElasticsearchLogsBody): LogsPage {
  const logs = (doc.hits?.hits ?? []).map(hit => hit._source ?? {})
  const rawTotal = doc.hits?.total
  if (typeof rawTotal === 'number') return { logs, total: rawTotal, totalRelation: 'eq' }
  if (typeof rawTotal?.value === 'number') {
    return { logs, total: rawTotal.value, totalRelation: rawTotal.relation ?? 'eq' }
  }
  return { logs, total: logs.length, totalRelation: 'unknown' }
}
