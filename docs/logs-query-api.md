# `GET /api/mobile-logs` 查询参数（0.3.49）

App「日志」页（`dsh-mobile-flutter` 的 `lib/features/logs/logs_page.dart`）读
`logstash-mobile` 索引的入口。本文件是这条路由的**参数契约**：App 侧照此接分页与
关键词检索，网关侧（`src/logs-query.ts`）按同一口径校验。

## 鉴权

- 客户端只打**网关**（18443 / 18452）：`Authorization: Bearer <账号 token>` 或
  `dsh_ma_session` cookie；未登录 / token 被踢 / 过期 → **401**。
- 网关反代到 3080 时注入进程内随机键请求头 `x-log-query`；插件路由比对同一值。
  这枚键不落盘、不进客户端，**不要**在 App / 文档 / 脚本里造它。
- 直连 3080 打这条路由（不带进程内键）一律 401，属预期行为。

## 参数

| 参数 | 类型 / 约束 | 默认 | 说明 |
|---|---|---|---|
| `limit` | 整数，`1..200` | `100` | 本页条数。超过 200 **不再静默截断**，返回 400 `invalid_limit`。 |
| `offset` | 整数，`>= 0`，且 `offset + limit <= 10000` | `0` | 跳过多少条（ES `from`）。`offset + limit > 10000` 返回 400 `offset_window_exceeded`（Elasticsearch 默认 `max_result_window`）。 |
| `since` | `^[1-9][0-9]{0,5}[smhdw]$` 的 ES date math 偏移 | `2h` | 时间窗起点为 `now-<since>`。例：`15m`、`2h`、`24h`、`7d`。 |
| `level` | 逗号分隔的级别列表 | 空（全部） | 与 `since` / `q` 是 **AND** 组合。例：`warn,error`。 |
| `q` | 字符串，最长 200 字符 | 空（不检索） | 对 `message` 做 `match_phrase`（短语匹配，大小写不敏感），与其余条件是 **AND** 组合。空白会被 trim；空串等同不传。 |

非法参数（负 offset、非数字 limit、`limit=0` / `limit>200`、非法 `since`、超长 `q`、
越界 `offset`）一律 **400**，响应体带可读原因：

```json
{ "error": "invalid_offset", "message": "offset 必须是不小于 0 的整数" }
```

**不会**静默回落到默认值，也**不会**返回空页让客户端误以为「没有日志」。

## 响应

```json
{
  "ok": true,
  "total": 39,
  "totalRelation": "eq",
  "count": 10,
  "offset": 0,
  "limit": 10,
  "logs": [ { "@timestamp": "…", "level": "info", "message": "…" } ]
}
```

| 字段 | 语义 |
|---|---|
| `total` | **真实命中总数**，来自 ES `hits.total.value`（请求带 `track_total_hits: true`）。**不是本页条数。** |
| `totalRelation` | ES `hits.total.relation`。正常情况下是 `eq`（精确）；拿不到总数时是 `unknown`，此时 `total` 退化为本页条数——只有在 ES 不返回 `hits.total` 这种异常响应下才会出现。 |
| `count` | **本页条数**（= `logs.length`）。这是 0.3.48 之前 `total` 的旧语义，换名保留，老客户端若依赖「本页条数」应改读它。 |
| `offset` / `limit` | 本次查询实际生效的分页参数（默认值也会回填）。 |
| `logs` | 本页 `_source` 白名单：`@timestamp`、`level`、`message`、`tag`、`service`、`app_version`、`build`。按 `@timestamp` 倒序。 |

## 设计取舍

**分页用 `offset`（ES `from`），不用 `search_after`。** App 要显示「共 N 条」并允许
直接翻到第 N 页；`offset` 是无状态参数，翻页只需换一个数字。`search_after` 要求
把上一页返回的 sort 游标原样带回、只能顺序往后翻、无法任意跳页，对日志页是额外
复杂度。代价是深分页受 ES `max_result_window`（默认 10000）限制——所以本路由在
`offset + limit > 10000` 时**明确 400 并说明原因**，而不是让 ES 返回 400 再被包成
不可读的 502。

**检索用 `match_phrase`，不用 `simple_query_string`。** 关键词应当作**短语**匹配，
不能被 `+` / `-` / `OR` / 引号 / 括号这类查询语法改变语义，也不能因为用户随手输入
一个 `"` 就让 ES 解析失败。`message` 的 mapping 是 `text`（标准分析器：英文按词、
中文按字切分），`match_phrase` 对中英文都成立。

会被搜到的样例：`q=codepush` 只命中消息里含 `codepush` 这个短语的文档，例如
`[codepush] phase checking → upToDate：当前是基础版本（还没打过补丁）`；不含该词的
日志（如 `[mperf-native] …`）不会命中。与 `since=24h&level=warn` 组合时三个条件取
交集。

## 示例

```sh
# 第一页（默认 100 条 / 2 小时）
curl -sS -H "Authorization: Bearer $TOKEN" \
  'https://<gateway>/api/mobile-logs'

# 第二页：同一时间窗，跳过前 10 条
curl -sS -H "Authorization: Bearer $TOKEN" \
  'https://<gateway>/api/mobile-logs?limit=10&offset=10&since=24h'

# 关键词 + 级别 + 时间窗
curl -sS -H "Authorization: Bearer $TOKEN" \
  'https://<gateway>/api/mobile-logs?q=codepush&level=info&since=24h'
```

翻页时保持 `since` / `level` / `q` / `limit` 不变、只递增 `offset`，两页的
`message` + `@timestamp` 不会重叠（排序按 `@timestamp` 倒序；日志时间戳精确到纳秒）。

## 兼容性（0.3.48 → 0.3.49）

- 不带新参数的旧请求：`limit` 默认 100、`since` 默认 `2h`、无 `q` 时发给 ES 的
  查询条件与 0.3.48 完全一致（仍只有时间 `range` + 可选 `level` `terms`）。
- **唯一有意的语义变化**：响应 `total` 从「本页条数」改成「真实命中总数」，本页条数
  改名 `count`。老 App 只读 `logs`，不受影响。
- 以前会被静默放过的非法值现在返回 400：`limit > 200`（原为截断到 200）、
  `limit=0` / 非数字（原为回落 100）、`since` 非 date math（原为原样拼进 ES 后 502）。
- 响应新增 `totalRelation` / `count` / `offset` / `limit`；`ok` 与 `logs` 不变。
