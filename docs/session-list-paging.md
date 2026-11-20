# `POST /api/session/list` 服务端切片（0.3.50，opt-in）

移动端「全部会话」页此前每次刷新都拉全量。2026-11-21 实测一次响应
**3905 条 / 5,303,533 B 原始 JSON / 672,467 B gzip / 解码后对象图 ≈31 MB**，
宿主 TTFB **3.47–3.74 s**。宿主 API 目前给不出分页：安装版
`@deepseek-ai/dsh-api-session-controller` 的 `list(_request, signal)` 完全未读
`_request`（`lib/index.js:3988-3993`），契约里的 `cursor` 也没有实现；改宿主必须
重启 `dsh-web`，硬约束禁止。

所以分页落在**网关侧服务端切片**：手机永远拿不到全量，但**只有显式 opt-in 的
请求**才会被切片；已发布、还不认识 `nextCursor` 的 build 181 App 行为不变。

实现：`src/session-list-slice.ts` + `src/gateway.ts` 的 `proxySessionListPage` /
`sendSessionListPage`。宿主的回包是 RPC 信封：

```json
{
  "type": "server-response",
  "rpcId": "…",
  "result": { "ok": true, "value": { "items": [ … ] } }
}
```

切片后只替换 `result.value.items`（当页 ≤ `limit`），并在**同一层**
`result.value` 上按需追加 `nextCursor`；信封与 `items` 里每个对象的字段原样保留
（不删字段、不改值、不改名）。

## opt-in（硬约束）

| 请求 | 行为 |
|---|---|
| 完全不带 `_request` | **原样透传**；回包与 0.3.49 逐字节一致 |
| `_request` 里没有 `limit` 键（含只有 `cursor`） | **原样透传**；不切片、不追加 `nextCursor` |
| `_request.limit` 键存在 | 进入切片路径；先校验，非法就 400 |

判断依据是 `payload.args._request` 这个对象里**是否存在 `limit` 键**，不是值是否
为真：`limit: 0` / `limit: null` / `limit: "abc"` 都算「显式请求分页」，一律
400，绝不静默回落成透传。

## 参数

| 参数 | 类型 / 约束 | 默认 | 说明 |
|---|---|---|---|
| `payload.args._request.limit` | 整数，`1..sessionListPageSize` | 无（不带就透传） | 本页条数。`sessionListPageSize` 默认 20，配置区间 `1..100`；`limit=101` 永远非法。 |
| `payload.args._request.cursor` | `base64url(JSON([updatedAt, sessionId]))` | 无（第一页） | 上一页返回的 `nextCursor` 原样带回；解码失败 / 非规范编码 → 400。 |

> 注意线参数名是 `_request`（宿主契约里的占位参数），不是 `request`。App 侧见
> `dsh-mobile-flutter-next` 的 `lib/core/remote/namespaces/session.dart`

非法参数一律 **400**，响应体带可读原因（App 可原样展示）：

```json
{ "error": "invalid_limit", "message": "limit 必须是 1 到 20 之间的整数" }
{ "error": "invalid_cursor", "message": "cursor 必须是网关下发的 nextCursor（base64url(JSON([updatedAt, sessionId])))" }
```

**不会**静默截断 `limit`，也**不会**把非法参数回落成「第一页」。

## 响应

```json
{
  "type": "server-response",
  "rpcId": "…",
  "result": {
    "ok": true,
    "value": {
      "items": [ { "sessionId": "…", "updatedAt": 1763…, "running": false, "…": "…" } ],
      "nextCursor": "<base64url(JSON([updatedAt, sessionId]))>"
    }
  }
}
```

| 字段 | 语义 |
|---|---|
| `result.value.items` | 当页条目（≤ `limit`）。**每个对象的字段与上游原样一致**。 |
| `result.value.nextCursor` | **只在还有下一页时出现**；拿到它就带回下一次请求。末页没有这个键。 |

响应按需 gzip（客户端 `Accept-Encoding: gzip` 时），与 `/api/session.history`
的压缩口径一致。切片路径强制上游按 `identity` 回包（网关自己再压），因此切片
结果不依赖上游是否压缩。

## 游标语义（keyset）

- 排序键：`updatedAt desc, sessionId asc`。`sessionId` 按 **UTF-8 字节**比较，
  不受进程 locale 影响（与 ACP `listSessions` 的 `compareSessionIds` 同口径）。
- 游标内容：`base64url(JSON([updatedAt, sessionId]))`，取本页**最后一条**的排序键。
- 解码要求**规范编码**：重新编码必须与传入值逐字节相等，否则 400。这样同一位置
  不会有多种写法混进来。
- 下一页的条件：`updatedAt < cursor.updatedAt`，或 `updatedAt` 相等且
  `sessionId` 按字节 **大于** 游标 id。

### 跳位与不重复保证

- **不重复**：每页从「严格位于游标之后」的条目开始，游标取自上一页最后一条，
  因此同一个 `(updatedAt, sessionId)` 不会被两页同时返回（第 1 页与第 2 页的
  id 交集为 0）。
- **允许跳位**：翻页期间某会话的 `updatedAt` 被更新（新消息），它的位置会前移。
  可能出现「翻完所有页后没看到它」——这是 keyset 分页的预期行为，不是丢条；
  重新从第一页开始即可拿到最新顺序。反过来，会话被删除会让后面条目前移，
  同样不会产生重复。
- **并列时间戳**：宿主的不带 limit 顺序只按 `updatedAt desc` 排（并列时保持
  数组原顺序）；切片路径为并列组补上 `sessionId asc` 作为确定性次键。因此
  若真实数据里存在同一毫秒的并列组，**分页顺序在并列组内部可能与全量顺序
  不同**，但「所有页拼起来 = 全量集合、且无重复」仍然成立。判定分页正确性时
  请按集合 + 不重复 + 无遗漏核对，不要假设并列组内部的相对顺序。

## 缓冲上限与超限透传

- 全量回包先读进内存，上限 **32 MiB**（实测全量 5.3 MB，留 6 倍余量）。
- 超限时**边读边透传**：已经缓冲的字节与剩余上游流原样写给客户端，放弃切片，
  回包是完整的全量（不截断、不回空页、不加 `nextCursor`），并写一条可诊断日志：

  ```text
  [dsh-mobile] session-list-slice passthrough reason=oversize bytes=<已读字节> limit=<limit> max=33554432
  ```

- 上游回非 JSON / 非 200 / 自带压缩体 / `items` 条目缺 `sessionId` 或
  `updatedAt` 时同样整单透传，日志带
  `reason=upstream_encoded|upstream_content_type|invalid_json|unexpected_payload|malformed_items`。
- 透传兜底的一条硬规则：**宁可让客户端拿全量，也不静默截断或回空页**。

## 短期缓存

- 只缓存**opt-in 切片请求**拉到的全量回包原始 JSON **字节**（≈5.3 MB），
  不缓存解码后的对象图（≈31 MB）——每页重新解析一次是有意的内存取舍。
- 单条缓存，key = 授权身份（`SessionAuthorization.sessionKey`），命中即按同一份
  全量数据切片；**缓存不改变切片语义**（命中与未命中走同一个
  `sendSessionListPage`）。
- `sessionListCacheMs` 默认 `30000`（30 s），配置区间 `0..3600000`；`0` = 关闭。
  固定 TTL、不滑动续期：持续轮询也不会让列表无限期停留在旧数据上。
- 不带 `limit` 的透传请求**不读也不写**缓存（保持逐字节透传，不额外占用内存）。
- 超过缓冲上限的体不会进入缓存。

## 兼容性

- **build 181 及更早的 App**：只发 `_request: {}`（或带一个无意义的 cursor），
  网关原样透传，回包与 0.3.49 **逐字节一致**（3905 条、无 `nextCursor`）。
- **新 App**：在 `_request` 里加 `limit` 即进入分页；`items` / `nextCursor`
  的名字与宿主终局契约一致，将来宿主自己实现 `limit/cursor/nextCursor` 后，
  网关这段可以退化为纯透传，App 零改动。
- 只改 `POST /api/session/list` 一条路由：`/api/session.history` 的既有改写、
  `/api/mobile-logs` 的 offset 分页、`/plugins/events` 的帧过滤一律不动。
