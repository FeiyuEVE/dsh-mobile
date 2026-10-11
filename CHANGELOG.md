## 0.3.44 — 2026-10-11 · **共享账号表下的写回竞态**：关闭路径先重读盘；撤销接口不再能被拼错的键骗成「撤销自己」

**背景**（真机实测，时间戳级证据）：三服（web / staging / rescue）共用一份
`~/.dsh/mobile-access/tokens.json` 后，出现两个独立缺陷：

1. **关闭时的整表写回会把别的进程刚写的改动整条抹掉**。`AccountController.finishClose()`
   从前是「拿本进程内存快照 `prune()` 后直接 `tokenStore.save()`」——**既没拿跨进程锁，
   也没先对齐盘上状态**。实测：`21:36:53.766` staging 撤销了一枚 token，300 ms 后
   （`21:36:54.066`）web 关闭（`systemctl restart`）时的写回把这条撤销**整条抹掉**，
   那枚凭据在盘上复活了 **26 分钟**；22:03 复现时方向相反——staging 关闭时用它 26 分钟
   前的旧记录覆盖了 web 的新撤销（撤销时间戳倒退）。指纹比对救不了：`mtimeMs:size`
   在「同一毫秒 + 同样长度」的两次写上会撞车。
2. **`POST /mobile-access/auth/tokens/revoke` 的 `id` 兜底是 fail-open 的**：body 里没有
   合法 `id` 时它当成「撤销自己」，于是把键名拼错（`tokenId`）的请求也会**回
   `{"ok":true,"revoked":1}` 并撤掉调用方自己那枚**——之后每个请求 401，现象像
   「撤销不可靠」。

**改法**：

- `src/account.ts`：`finishClose()` 走 `withStateLock` + `refreshSync(force: true)` 后
  再 prune/save；**读不出盘就不写**（宁可少写一次，也不拿陈旧内存覆盖）。
- `src/account.ts`：`refreshSync(force)` 返回「内存是否与盘一致」；`exclusive()` 里
  读盘失败 → `503 state_busy`（不再拿陈旧内存写盘）；失败时**不再把内存标记成
  「与盘同步」**（否则下一次写盘会跳过重读）。
- `src/account.ts`：`stateFingerprint` 计入 `ino`——写盘是「临时文件 + rename」，每次写
  都换 inode，才能区分同一毫秒、同样长度的两次写。
- `src/account.ts`：`withStateLock` 的陈旧锁回收失败（权限/类型异常）不再 `continue`
  空转（那是不看 deadline 的死循环，会把进程卡在一次登录上），改为落下去按 deadline
  抛 `503`；释放时**只删自己那把锁**（比对写入的 nonce），避免误删陈旧回收后别人刚拿到的锁。
- `src/gateway.ts`：`handleAccountRevoke` 只认 `id` / `all` / `self` 三个键，
  **别的键一律 400**（拼错的 id 绝不能落进「撤销自己」兜底）；`{}` 仍等于撤销自己
  （App 的既有形状，向后兼容），新增显式 `{self:true}`。

**测试**：`tests/account.test.ts` 新增 5 例（关闭写回不得抹掉别台刚签发的 token / 不得让
已撤销的 token 复活 / 读不出盘时关闭与变更路径都不写盘 / 陈旧锁删不掉时按 deadline 收口 /
指纹能区分同毫秒同长度两次写），`tests/gateway.test.ts` 新增 1 例撤销契约
（拼错键 400 且双方都还活着、撤别人不影响自己、不存在的 id 404、`{self:true}` 撤自己）。
跨进程写回那两条在旧实现上**必红**。

## 0.3.43 — 2026-10-11 · **账号表可跨 uid 共用**：新增 `accountFileMode`，读方 chmod 失败不再让整棵插件起不来

**背景**：0.3.42 让三服可以指向同一个 `accountDir`，但本机形态是**自救服务跑 root、
正式服/测试服跑 feiyueve**。一旦某个 uid 写过 `account.json` / `tokens.json`，另一个 uid
下次启动时 `readStateFile()` 会先对这份**别人属主**的文件 chmod → `EPERM`；而
`Gateway.start()` 又把 `account.initialize()` 放在 `try` 之外，于是**整个 dsh-mobile
插件加载失败**（18443 / 18452 网关直接起不来）。这不是数据损坏，只是权限位问题：模式该由
**写方**决定，读方读得到就行。

**改法**：

- `src/private-file.ts`：`restrictPrivateFile()` 容忍 `EPERM` / `EACCES`（返回而不是抛，
  每个路径只刷一条 `process.emitWarning`，避免每次读盘都刷屏）；**其它错误照旧抛**
  （`ENOENT` 之类才是真问题）。Windows 侧的 icacls 收紧不变。
- `src/config.ts`：新增 `accountFileMode`（默认 `0o600`，单进程老行为逐字节不变），白名单
  只有 `0o600` / `0o620` / `0o640` / `0o660`——属主 rw 必选、共享组可选 r/w、**other 位
  一律不许**（账号表对 other 可写 = 任何人能给自己签 token；可读 = 密码 scrypt 摘要与
  token 摘要外泄）。写错（例如把 `0640` 写成十进制 `640`）**当场报错**，不静默落一个
  谁都没预期的模式。
- `src/account.ts`：`JsonAccountStore` / `JsonTokenStore` 的落盘模式（原先写死 `0600`）
  改为构造参数，`readStateFile` / `writeStateFile` 都按它走。
- `src/plugin.ts`：`createAccountController` 把 `resolved.accountFileMode` 传给两个 store。

**测试**（265 例全过；本轮新增 9 例）：新增 `tests/private-file-tolerance.test.ts` 7 例
（EPERM/EACCES 容忍且每路径只警告一次、`ENOENT` 与「无 code」错误照旧抛、成功不刷警告、
成功/失败交替互不影响——与同名 `private-file.test.ts` 分开放，因为那支要真实 chmod 才能
断言 `0600` 生效，mock 会让它失真）；`tests/config-network.test.ts` 新增 1 例（四个合法值
逐个接受、十类误写逐个拒绝）；`tests/account.test.ts` 新增 1 例（`0o640` 落盘 + 另一进程按
同模式读回仍认这枚 token + 不配模式的仍是 `0600`）。

**部署**：三服 `cordis.patch.yml` 的 `mobile-access` 块共用一份账号表（`accountDir` +
`accountFileMode: 0o640`），账号目录 setgid 到共享组 `dsh-shared`；重启顺序
staging → rescue → web（web 最后）。

## 0.3.42 — 2026-10-11 · **三服统一鉴权**：账号与令牌表可跨进程共用（`accountDir`），一台登录另一台立刻认

**背景**：0.3.39 起每个 profile 各有一份 `account.json` / `tokens.json`，而三个网关
（web 18443 / staging 18452 / rescue 18453）报的 `instanceId` 又是同一个值（都是配对 CA 的
SHA-256 指纹，见各自 `cordis.patch.yml`）——App 按 `instanceId` 存 token ⇒ **三服共用一枚
token 槽**：在测试服登录后切到正式服，正式服收到的是测试服签发的 token → 401 → App
「登录态已失效」清登录态回登录页。用户口径是「移动端整个只需要一个独立的鉴权，几个环境和
模式都应该用统一的鉴权，而不是分环境」。

**改法（服务端）**：

- **新增配置 `accountDir`**（`src/config.ts`）：账号与令牌目录。省略 = 沿用 `stateFile` 所在目录
  （单进程老行为，行为逐字节不变）；多台指向同一个目录 ⇒ **共用一份账号与令牌表**。
  `src/plugin.ts` 的 `createAccountController` 改用 `resolved.accountDir`，并给
  `AccountController` 传 `lockPath`（同目录下的 `.account.lock`）。
- **读路径跨进程刷新**（`AccountController.refreshSync`）：按**文件指纹**（mtime+size，
  `JsonAccountStore/JsonTokenStore.revision()`）判断盘上是否被别的进程改过，变了就同步读一次
  （`loadSync()`）。挂在 `tryAuthorize` / `assertCsrf`（经 `recordForSession`）/ `tokenIdOf` /
  `hasAccount` / `currentUsername` / `listTokens` / `login` 上——**对方刚签发的 token 立刻可用**，
  不需要等重启或轮询。读盘异常（半截内容等）**保留内存快照**：宁可暂时用旧表，也不因为一次读盘
  异常把所有人登出。
- **跨进程读改写锁**（`withStateLock`）：写盘是「整份快照原子替换」，两个进程交错会丢掉其中一方
  刚签发的 token。锁文件 `wx` 创建即独占；持有者崩溃留下的陈旧锁（>15s）自动回收；拿不到锁
  （>3s）**抛 503 `state_busy`** 而不是静默继续写。
- **改密改成「标记撤销」而不是写空表**（`setAccount`）：空表会把别的进程刚签发的 token 一起从盘上
  抹掉，而对方内存里那条仍算活跃 —— 「改密即吊销」的承诺落空。标记撤销对所有进程都成立。
  代价：改密后设备列表会多出「已撤销」记录（保留 7 天，与单条撤销同一口径）；两种拒绝路径
  （不在表里 → `undefined`／在表里但已撤销 → 抛 401）对客户端都是 401，安全语义不变。

**测试**：`tests/account.test.ts` 新增 5 例（另一进程立刻认新 token、一台撤销另一台立刻失效、
并发登录不互相覆盖、改密跨进程吊销、陈旧锁回收）；`tests/config-network.test.ts` 新增 1 例
（`accountDir` 默认值与显式值）。全量 `npm test` 255→**261 例全过**。

**部署**（本次只动测试服；正式服待重启窗口）：`~/.dsh/profiles/staging/cordis.patch.yml` 的
`mobile-access` 块加 `accountDir: /home/feiyueve/.dsh/mobile-access`（正式服自己的目录），
重启 `dsh-staging` 生效。**⚠️ 正式服（`dsh-web`）也要装上 0.3.42 并重启**才双向可见——
老代码只在构造时读一次 `tokens.json`。

## 0.3.41 — 2026-10-11 · 日志面收紧：两条日志路由都改账号会话鉴权，**部署令牌整体退役**（App 不再内置任何静态日志令牌）

**背景**：0.3.38 起日志面有两枚**写死在源码里**的静态令牌，谁都能从 APK / 仓库里读到（对抗性验证记录见父仓库 `CHANGES.md` 2026-10-11 条目）：

1. `GET /api/mobile-logs` 只要带 `X-Log-Query: <LOG_QUERY_TOKEN>`，网关就**合成一个固定会话**直接反代到 3080 读 ES `logstash-mobile`——不要账号、不要 cookie；
2. `POST /log-ingest` 只要 `X-Log-Token` 命中「部署令牌 + 页面令牌」白名单（同一份白名单还写在 frps nginx 与 `dsh-web-supervisor` 里）就把 body 转进本地 logstash **任意写入** ES。

**改法**：

- **查询面（读）改成账号会话**：`GET /api/mobile-logs` 现在走 `authorize()`——Bearer 或 `dsh_ma_session` cookie，未登录 / 被踢 / 过期一律 **401**（App 侧回登录页）。`LOG_QUERY_TOKEN` 静态常量**删除**。
  网关反代给 3080 时改为注入**进程内随机键** `x-log-query`（`LOG_QUERY_KEY`，启动时 `randomBytes(32)`，不落盘、不进客户端）：两半在同一进程里，而 3080 那条插件路由不可能复用客户端凭据（网关是用自己那枚 upstream cookie 代理过去的），也不能裸奔（3080 监听 `0.0.0.0`，同网段直连者不该读得到移动端日志）。客户端给的同名头在 `sanitizeRequestHeaders` 里被**移出放行列表**，只有网关那一次显式注入（`proxyHttp` 新增的 `extraUpstreamHeaders`，写在 sanitize 之后）能写进这个头。
  代理会话的 `expiresAt` 仍按 1 小时夹住（30 天 token 的真实 `expiresAt` 超出 `setTimeout` 的 32 位毫秒上限，会被 Node 截断成 1ms 而立刻断连）。
- **上报面（写）拆成两条，凭据各不相同**：
  - `POST /log-ingest`（页面错误守卫 / 移动端体检探针）：**只认页面令牌**（`dshm-page-ingest-…`，部署经 `__DSH_INGEST_TOKEN__` 注入，只有登录后的页面拿得到）。**部署令牌从白名单里移除**。
  - `POST /mobile-access/log-report`（**新**，App 原生上报）：凭**账号会话**（Bearer / cookie），只写遥测、不要求 CSRF；未登录 **401**，body > 1 MiB **413**，logstash 不可达 **502**。App 因此不再内置任何静态日志令牌——公网 `/log-ingest/` 直连（frps nginx → 18447 隧道 → logstash）也就没有 App 侧使用者了。
- **`LOG_INGEST_TOKENS` 常数集并成单个 `LOG_INGEST_PAGE_TOKEN`**。

**破坏性变更 / 迁移**：

- **部署令牌 `84153b5d…` 整体退役**：从 `src/gateway.ts`、frps nginx `dsh-mobile.conf`（`= /log-ingest`、`/log-ingest/`、`= /rescue-intake/report` 三处白名单）、`dsh-web-supervisor` 的 `checkReportAuth` 里都删掉。
- **旧 App（≤ build 117）**：它写死的就是这枚部署令牌，收紧后 ES 上报与 App 内日志页都会失败（App 侧静默 / 报错，本地日志文件与设置页「复制日志」不受影响）——`dsh-mobile-flutter` 的对应用法要随**下一个 build** 一起发。**页面错误守卫与移动端探针不受影响**（它们用页面令牌）。
- **轮换口径变了**：以后只需维护**页面令牌**一处（profile 的 `ingestPageToken` + nginx + supervisor）；查询键随进程随机生成，不与任何客户端同步。

**验证**：`npm run verify` 退出 0，**250 测试**（23 文件）通过（0.3.40 是 247）。新增 / 改写：`tests/gateway.test.ts` 的「App 上报只认账号会话（匿名 401 / 两枚退役静态令牌都 401 / 被撤销凭据立刻 401）」「`/log-ingest` 只认页面令牌（匿名与部署令牌 403、页面令牌放行）」「查询路由要账号会话 + 只有进程内随机键能进 3080（匿名与旧静态令牌 401，转发头上是 `LOG_QUERY_KEY`）」；`tests/plugin.test.ts` 的查询路由用例改用共享键并断言旧常量已失效。

## 0.3.40 — 2026-10-11 · 把配对模式**真删干净**（设备凭据 / 配对端点 / 配对页全下）+ 修 0.3.39 的 token 表自锁 + 浏览器侧改账密登录页

**背景**：0.3.39 只**新增**了账密端点，配对那套状态机整体还在。上线后一次对抗性验证把它坐实了：`~/.dsh/profiles/staging/mobile-access/devices.json` 里 **25 条设备凭据全部未撤销、未过期**（最早 2026-12-01 到期），而 `authorize()` 仍是「先查账号 token，查不到回落 `access.authorizeSession()`」，`POST /mobile-access/auth/renew` 公网可达且免 CSRF——**任何握着旧设备令牌的人（旧 APK、旧浏览器 cookie 里就有）不需要账号密码就能换到完整会话，全通 `/api/*`**。同时浏览器 `/mobile-access/login` 还是那张「This device is no longer paired → Open pairing」的旧页，它唯一的动作也是打 `renew`。也就是「去掉配对模式」当时只在 App 那条路上成立。

**改法（按用户口径「配对彻底删除」）**：

- **删掉整条配对链**：`src/access.ts` 的 `AccessController`（配对窗口、设备表、短会话、续期）、`src/storage.ts`（`JsonDeviceStore`/`MemoryDeviceStore`/`DeviceSnapshot`）、`PAIR_PAGE`/`PAIR_SCRIPT`、`POST /mobile-access/auth/pair`、`POST /auth/renew`、`GET /mobile-access/pair(.js)`、管理面 `POST {prefix}/pairing/open`、`GET {prefix}/devices`、`POST {prefix}/devices/{revoke,reset}`。`access.ts` 只剩三样被账号链路复用的东西：`AccessError`、`SessionAuthorization`、`BoundedRateLimiter`。
- **`authorize()` 不再回落设备会话**：凭据只有一种——账号 token（Bearer 或 `dsh_ma_session` cookie）。不认识的凭据一律 401，`devices.json` 再没被读过（旧令牌就此作废，文件可留档）。
- **浏览器那条路改成账密**：`/mobile-access/login` 现在是**账密表单页**（POST `/auth/login` → Set-Cookie → 回跳 `return`），文案与错误码提示都按账号口径写；SPA bootstrap 从「401 → `renew` → 重放」改成「**401 → 导到登录页**」（也不再包 WebSocket 补丁：手工握手失败分不清掉登录还是网络抖动，误判会把整页踢走）。
- **顺手修三个真 bug**：
  1. **token 表容量算错会自锁**（0.3.39 引入）：`maxTokens` 只按「活跃 token」算淘汰，而 `tokens.json` 的解析上限用的是**同一个数字**（`parseTokenSnapshot(snapshot, maxTokens)`）。于是「活跃打满 32 → 踢掉一台（记录还要留 7 天）→ 再登录」写出的快照长度 33 → 解析直接抛错 → 登录回 500 `internal_error`，**最长 7 天登不进去**。现在快照上限与活跃上限分开（`tokenSnapshotLimit(maxTokens) = maxTokens + 64`），淘汰顺序是「先最久未用的活跃、再最旧的撤销记录」，`MemoryTokenStore` 也接受上限参数（测试才盖得到这条路径）。
  2. **改密可能留下半成品**：原来是「先落新账号 → 再清 token 表」，第二步写盘失败就变成「新密码已生效、旧 token 仍可用」。现在顺序反过来（**先吊销并落盘 token，再落账号**），最坏情况是改密没成（旧密码仍可登录），不会出现吊销承诺落空。
  3. **登出必然 400**：`authLogout` 不发 body，而服务端 `readJsonObject` 要求非空 JSON → `400 bad_request`，**服务端那枚 token 从来没被撤销过**。现在 `readJsonObject` 支持 `{allowEmpty:true}`（只给登出这种无参动作用），空体读成 `{}`。
  4. **登录与改密竞态**：scrypt 期间账号可能已被替换，签发前在 `exclusive` 里复核 `this.account === account`，不让旧密码换到的新 token 落进刚清空的表。
  5. **App 分发路由忽略查询串**：`GET /mobile-access/app/manifest.json?x=1` 不再 404（cache-busting 参数是客户端常用手法）。
- **metadata 多回一个 `instanceId`**：App 拿它把「同一台实例的局域网 / IPv6 / 公网入口」认回同一个身份，从而**一枚 token 三条线路通用**；认不出来（老插件）就退回按 origin 存，也不会串到别的服务。

**破坏性变更 / 迁移**：

- 移除的端点：`/mobile-access/auth/pair`、`/auth/renew`、`/mobile-access/pair`、`/mobile-access/pair.js`、管理面 `{prefix}/pairing/open`、`{prefix}/devices`、`{prefix}/devices/revoke`、`{prefix}/devices/reset`。管理面 `{prefix}/status` 的 `pairing`/`deviceCount` 换成 `accountConfigured`/`tokenCount`。
- **旧 App（≤ 0.5.1+116）**：IPv6 / 公网线路退化（它靠 `native-pair`/`native-renew` 取会话）→ 回落到仅局域网；局域网与「浏览器配对页」那条路本来就不在本次范围内，但**配对页已经删了**，浏览器侧现在必须用账号密码。
- **同仓库的 Kotlin App（`apps/mobile`，`io.github.sayach.dshmobile`）**：它的 `NativeAuthClient.pair/renew` 打的就是这两条已删端点，**原生配对链路整体失效**；WebView 那条路仍可用（网关登录页现在是账密表单）。移植到账密登录**本次未做**，需要用户拍板「移植」还是「退役」；本次只跟着 `check:mobile-release` 的要求把 `versionName` 同步到 0.3.40（versionCode 75）。

**配置侧（`~/.dsh/profiles/*/cordis.patch.yml`）**：web 与 staging 都放开 `listenHost: 0.0.0.0`、把本机局域网地址加进 `publicAuthorities`、`allowedCidrs` 收到 `[127.0.0.0/8, 192.168.0.0/24]`（局域网线路现在也走网关，所以必须能连上；但没必要把整个 /16 都放进信任面）。`maxDevices` / `pairingTtlMs` 留在配置里只为兼容旧 profile 的键，实际不再生效。

**验证**：`npm run verify` 退出 0；`tests/access-storage.test.ts` 随设备表一起删除；`tests/gateway.test.ts` 的 `pair()` helper 整体换成「设账号 → `POST /auth/login`」，并新增：**旧设备令牌（cookie 与 Bearer 两种形态）一律 401**、`/auth/pair` 与 `/auth/renew` 回 **404**、**空体登出成功且随后 401**（证明服务端真撤销）、`?x=1` 的 App 清单不再是 404、`/mobile-access/login` 是账密表单页（不含 `Open pairing`）；`tests/account.test.ts` 新增 **token 表打满 → 踢一台 → 再登录必须成功** 的 JSON store 回归（就是上面第 1 条 bug）。

**注意**：0.3.39 的 token 表容量 bug 已经跟着这一版修掉，但**已经装出去的 0.3.39 若在打满前没升级，仍会踩到**——staging 已就地更新到 0.3.40。

## 0.3.39 — 2026-10-11 · 鉴权改成「单账号账密登录 + 一个月 token」：配对模式退役，一枚 token 通用局域网 / IPv6 / 公网

**背景**：配对模式（配对码 → 设备令牌 90 天 + 会话 8h）有两个结构性问题。其一是**体验**：换机、清数据、换浏览域都要重新配对，用户口径是「和其他有账密的常规 APP 一样」。其二是**一枚凭据通用不了**——局域网线路直连 dsh-web 的 `dsh-auth-<sha256(authority)>` cookie **按 authority 签名**（同一令牌打 `127.0.0.1:3080` 与 `192.168.0.240:3080` 是两枚不同 cookie），而 IPv6/公网走网关的 `dsh_ma_*`，两条线路两套认证、各自会过期。

**改法**（新增 `src/account.ts`，不动 `access.ts` 的配对状态机，把回归面压到最小）：

- **账号**：单账号，密码只存 **scrypt(N=32768,r=8,p=1) 派生值 + 随机 salt**（`account.json`，0600，原子写）；明文永不落盘、不入日志、不回显。改密即吊销全部 token。
- **token**：登录签发 43 字符不透明令牌，有效期 **30 天**，落 `tokens.json` 且**只存 sha256 摘要** + 独立 csrf 摘要；`lastSeenAt` 只在超过 1 小时后于内存推进（不做每请求写盘），退出时统一落盘。
- **一枚 token 两种形态**：原生 API 走 `Authorization: Bearer`，WebView 走同名 cookie `dsh_ma_session`（csrf 走 `dsh_ma_csrf`）——三条线路同一个认证面。
- **端点**：`POST /mobile-access/auth/login`（免会话，必须排在 `authorize` 兜底之前，否则鸡生蛋）、`GET /auth/session`（凭据自检）、`GET /auth/tokens` + `POST /auth/tokens/revoke`（已登录设备列表 / 踢下线）、`GET /mobile-access/app/{manifest.json,*.apk}`（**App 内更新先校 token** 再流式反代本地 APK 服务；nginx 那五个公开 dl 入口不动，浏览器下载页保持公开）。
- **管理面**（仅回环 `assertLocalAdminTrust`）：`POST /api/mobile-access/account` 写账号、`GET /tokens` / `POST /tokens/revoke`。
- **删除 App 专用配对端点** `native-pair` / `native-renew`；浏览器那条 `/auth/pair` + `/auth/renew` + 配对页**保持原样**（用户口径：浏览器保持现状）。

**三条硬约束（都写进了注释，别再踩）**：

1. **授权视界必须钳到 20 天以内**：网关 `allocateRequest` 用 `setTimeout(authorization.expiresAt - now)` 做请求/长连接的生命周期，超过 2^31-1 ms（≈24.8 天）会被 Node **截断成 1 ms** → 30 天的 token 若原样进授权对象，**每条请求都会被立刻 abort**。`AUTHORIZATION_HORIZON_MS = 20 天`，token 自身到期时间另行保留。
2. **token 必须落盘**：老会话是内存 Map（`access.ts` 的 `sessions`），重启即掉；一个月有效期若沿用内存就等于从未兑现。
3. **cookie 优先于 Authorization**：请求里另有一枚无关的 `authorization` 头是合法场景（上游 header 白名单会把它剥掉，`tests/gateway.test.ts` 就有这条用例），无条件把 Authorization 当凭据会把这类请求判成 401。

**验证**：`npm run verify` 退出 0（24 文件 / **246 例**）；新增 `tests/account.test.ts` 13 例（scrypt 只存派生值、未配账号回 409、一个月时长判据、**跨重启仍有效**、视界钳位、到期拒绝、错密码/未知用户/按源限流、CSRF 绑定、撤销即失效并触发资源回收、改密吊销、`maxTokens` 按 lastSeenAt 淘汰、0600 与符号链接拒绝）；`tests/gateway.test.ts` 把原 native-pair 用例改写成账密契约（Bearer 与 cookie 两种形态、普通 authorization 头不抢 cookie、设备列表回包不含 token、缺 CSRF 403、撤销后 401）。

**注意**：本版删掉 `native-pair`/`native-renew` 后，**尚未更新的 App（≤ 0.5.1+116）在 IPv6 / 公网线路上会退化**（其自动配对第三步拿不到端点，回落到「仅局域网」）；局域网线路与浏览器配对不受影响。新 App 用账密登录，不再需要这两条端点。

## 0.3.38 — 2026-10-09 · 客户端诊断 url 改对象形态 + dsh 0.2.1 兼容（版本门 / peer / `ctx.layout.panelInfo` 适配）：此前整类诊断被摄入管道静默丢弃

**症状**：插件自带的 `reportClientDiagnostic`（文件资源提供者缺失、移动页状态等诊断）在真机上一条都查不到——ES 里 `mobile-page-state` 自上线以来零条，页面侧却没有任何报错。

**根因**：`src/client.ts` 把 `url` 发成字符串（`` `${location.origin}${location.pathname}` ``）。摄入管道按**对象**取 `url`（`url.path` / `url.domain`），字符串形态的事件会被**静默丢弃**：客户端仍看到 HTTP 200，服务端什么都不落。同一约束 2026-09-24 在做移动端探针时已实测过（探针改成对象后才开始有数据）。

**修复**：改为 `url: { path: location.pathname, domain: location.hostname }`，与探针一致；`pathname` 不含查询串，页面 token 仍然不会外发。

**验证**：
- `tests/client-diagnostics.test.ts` 断言 `body.url` 等于 `{ path, domain }`，并保留 `?token=secret` 的 stub 作「绝不外发 token」哨兵。
- `npm run test` 23 文件 / **231 例**全绿，`npm run typecheck` 0 错，`npm run build` 通过。
- 实机链路：重建的 `lib/client.js` 覆盖到 web/staging 两个 profile 的已装副本后，从 3080 拉 `/plugins/??@feiyueve/dsh-mobile/client.js&rev=…` 确认下发的是新形态（备份在 `/home/feiyueve/tmp/mobile-perf/dsh-mobile-installed-backup/`；rev 由 mtime/ctime/size 派生，改文件即换 URL，无需重启）。

**注意**：本次只就地覆盖已装副本，私源 `@feiyueve/dsh-mobile` 仍是 `0.3.37`；下次发版要把这条作为 0.3.38 发布并同步两个 profile。

### 附带：dsh 0.2.1-alpha.1-local.1 兼容核对（版本门 / peer 跟版 / `ctx.layout.panelInfo` 适配）

**版本门与跟版**：`src/compatibility.ts` 白名单与 4 处 dsh `peerDependencies` 加 `0.2.1-alpha.1`、`0.2.1-alpha.1-local.1`（前者是为容器测试台——私源只发布了 pristine 版本，`-local.1` 未发布；0.1.6 世代也同时声明过 pristine + local）。另两处依赖不匹配 0.2.1 基线，会各自落成第二份副本：`@deepseek-ai/cordis` peer `^4.0.1` → `^4.0.1 || 4.0.5-alpha.1`（semver：prerelease 只在同 `[major,minor,patch]` 比较器带 prerelease 时才被接受，`4.0.5-alpha.1` 不被 `^4.0.1` 命中），`@deepseek-ai/schemastery` 依赖 `^3.18.1` → `3.18.5-alpha.1`（0.2.1 vendor 版本；本插件只用 `z.string/natural/object/array/union/boolean/const`，未用 `.volatile()`，故副本分裂对它无功能影响，跟版是为了不落第二份）。

**API 适配（必需，已做反向验证）**：dsh 0.2.x 给官方 `ILayout` 增加了 `panelInfo`（`HostObservable<PanelInfo>`），且有 4 处客户端模块直接读 `ctx.layout.panelInfo`——`ui-sidebar-right` 在**加载期 effect** 里 `layout.panelInfo.getSnapshot()`、`ui-plugin-manager` 在 `main` 槽出现时 `subscribe`，另有 `ui-workspace`/`ui-open-in-app` 的两处快捷键条件。本插件的 `mobile-layout.js` **替换**官方 layout 模块，控制器缺这个成员时真浏览器实测**整块移动布局挂不上**：`drawer=0 shell=0`、连输入框都没有，而 `pageerror` 仍是 **0**（静默失败，HTTP 级验证完全看不出来）。修法：把 `panelInfo` 挂到 `MobileLayoutController` 上，并让 `provideRoot({hooks:{panelInfo}})` 复用同一份（两条读法同一快照源，仍按 `panelId` 缓存稳定引用）。

**兼容脚本的既存误报**：`scripts/check-dsh-compatibility.mjs` 要求 `PlanReviewPanel.tsx` 含 `data-plan-review-scroll`，该标记上游 **0.1.7（f6428a164e「计划评审改成决策卡」）就已删除**，其自身用例反向断言 `toBeNull()`；把脚本指向 0.1.7 的树同样报同一个错——即这是**升级前就存在的误报**，不是 0.2.1 的破坏性变更。已删除该断言并保留 `data-plan-review-key`（移动 CSS 仍在用）。

**验证**：`npm run verify` 退出 0（23 文件 **233 例**）；`node scripts/check-dsh-compatibility.mjs ../deepseek-harness` 退出 0（`DSH compatibility ok: 0.2.1-alpha.1-local.1 (renderer-v2)`）；容器测试台（`dsh-testbed-021`，dsh `0.2.1-alpha.1` + 本地 tarball）真浏览器 A/B——去掉 `panelInfo`：`手机面出现输入框` FAIL、`drawer=0 shell=0`；补上：两项 PASS、`drawer=1 shell=1`，两臂 `pageerror` 均 0（末项「真实模型回合」因测试台未注入凭据而失败，与本改动无关）。

**同代核对结论（未改代码）**：boot manifest / HMR graph 链路在 0.2.1 **未再变化**——`packages/host/webserver/src`、`packages/client/modules/src/index.ts`（boot 图与批次组装）、`packages/client/hmr/src`（`/plugins/events` 与 graph 帧协议）在 `dsh-v0.1.7-alpha.2..dsh-v0.2.1-alpha.1` 区间**逐字节未改**，本地 13 组补丁在该区间只给 `client/modules` 加了一行 index 注入（error guard），不影响条目 URL/批次形态；0.3.36/0.3.37 的两处修复继续有效。

## 0.3.37 — 手机页白屏的第二处根因：上游 stock graph 帧覆盖网关改写的 boot graph

**症状（0.3.36 之后仍复现，dsh 0.1.7）**：`mobile-boot` 批次已经能组装（0.3.36 修的 502 不再出现，批次 200、5.1 MB），但手机页仍是**白屏**，页面里 `pageerror: SlotAssemblyError: renderSlot('root') before any 'root' registration (boot order)`，body 为空；`.dshm-shell` 偶发挂上一瞬又被冲掉。

**根因**：移动页的 boot graph 是网关改写过的（布局模块 → `mobile-layout.js`、布局批次 URL → `mobile-boot/<hash>.js`），而 HMR 客户端一连上 `/plugins/events`，上游就推一帧**它自己那份 stock graph**；`entries.sync(graph)` 把页面手上的改写图整体覆盖回 stock → 官方布局模块被按 stock URL 重新拉取（实测网络日志里 `/plugins/??@deepseek-ai/dsh-client-ui-layout/client.js&rev=76ce175d3f8e` 紧跟 `/plugins/events` 之后出现）→ 专属布局的 root 注册被冲掉 → shell 渲染 `root` 插槽时零注册 → React 树崩、白屏。
**判定实验**：同一次启动里把 `/plugins/events` 拦掉（`NO HMR`），页面立刻正常挂载（`textbox=1`、`.dshm-shell=1`、无 root 报错），stock 布局 URL 也不再被请求。

**修复**：网关在代理 `/plugins/events` 时过一层 `MobilePluginEventsFilter`——只丢 `type:"graph"` 的 SSE 帧，注释帧（`: connected`）与 `type:"rebuilt"`（单模块热替换）原样透传，HMR 心跳与单模块热更不受影响。从 stock 图同步回来的「插件集变化」对移动页本来就没有意义：手机页的模块集由网关按移动形态决定，换版本即换内容寻址 URL。

**验证**：
- `tests/gateway.test.ts` 新增用例「drops the upstream stock graph frame from the mobile /plugins/events stream」（上游 fixture 现在会推 graph + rebuilt 两帧）：断言 `: connected` 与 `"type":"rebuilt"` 到达、`"type":"graph"` 与 `"graph"` 一个都不剩。把过滤条件改成 `false` 该用例即失败（已实测）。
- `npm run verify` 全绿：23 文件 **231 例**（含新用例）、typecheck 0 错误、`check:mobile-release` 通过。
- 部署 web(18443)/staging(18452) 后真机路径复跑 `scratch-release/e2e/mobile.cjs`。

## 0.3.36 — dsh 0.1.7：boot manifest 的插件 URL 改为相对形态，mobile-boot 批次必须两种都认

**症状（线上，dsh 升级到 0.1.7-alpha.2-local.1 之后）**：手机经网关打开专用移动前端时**白屏**——HTML 回来了、`window.__DSH_MOBILE_FRONTEND__="dedicated"` 也在，但 `<script src="/mobile-access/mobile-boot/<hash>.js">` 回 **502**，响应体为空、`Content-Type: application/json`，浏览器报「Refused to execute script … MIME type ('application/json') is not executable」，页面里没有任何 DOM。

**根因**：dsh 0.1.7 把 boot manifest 的条目 URL 从绝对路径改成了相对路径（上游 `packages/client/modules/src/index.ts:472` 的 `artifact.url.slice(1)`，`0.1.6` 及更早是 `/plugins/??…`，`0.1.7` 起是 `plugins/??…`）。网关组装批次时 `readUpstreamClientBundle()` 硬校验 `source.startsWith('/plugins/')`，相对形态直接抛 `HttpError(502, 'upstream_unavailable')`，整份批次组装失败。

**修复**：
- `readUpstreamClientBundle()`：先把条目 URL 归一化成绝对路径（缺前导斜杠就补 `/`）再校验并取上游——两代 dsh 的形态都认。
- `stripStockBundlePreload()`：去掉 preload 的 `<link>` 时同样不再要求 `href` 里 `plugins/??` 前必须有斜杠，否则 0.1.7 下那条 4.5 MB 的重复预加载会漏剥（该修复的原始动机见函数注释）。
- `tests/gateway.test.ts`：上游 fixture 增加 `boot: 'relative'` 变体（相对条目 URL + 相对 preload），新增用例「assembles the mobile boot batch when the boot manifest uses 0.1.7 relative plugin URLs」——把归一化改回 `const normalized = source` 该用例即失败（已实测），批次的三个条目顺序、专用布局替换、preload 剥离同时被钉住。

**验证**：`npx vitest run tests/gateway.test.ts` 30/30（含新用例）；`npm run verify` 全绿；发布后用真实浏览器打网关 18443 复跑 `scratch-release/e2e/mobile.cjs`（配对 + 专用前端 + 布局 + 真实回合）。

# Changelog

Notable changes to DSH Mobile are recorded here. GitHub Releases remain the source for downloadable packages and complete generated commit notes.

## 0.3.34 - 2026-09-16

- Declare DeepSeek Harness `0.1.6-alpha.1` (and the local release line `0.1.6-alpha.1-local.1`) compatible: `SUPPORTED_DSH_VERSIONS` gains both, and the four `@deepseek-ai/dsh-*` peer ranges gain `|| 0.1.6-alpha.1 || 0.1.6-alpha.1-local.1` in the same release. Same hard ordering as 0.3.33 — the runtime gate quarantines the whole plugin tree, so this release has to reach the registry **before** 0.1.6 is deployed to the gateway.
- `scripts/check-dsh-compatibility.mjs`: two markers moved inside the conversation tree upstream (`data-conversation-scroll` from `skeleton/ConversationRoot.tsx` to `skeleton/ConversationContent.tsx`, `data-input-scroll` from `skeleton/InputBar.tsx` to `input/editor/DraftEditor.tsx`). The check now reads the whole `packages/client/ui-conversation/src/client` subtree through a recursive `sourceTextUnder()` helper for those two markers, while `data-composer-card` and `aria-haspopup="listbox"` stay pinned to `InputBar.tsx`. Verified against the 0.1.6 source tree: `DSH frontend contract recognized: 0.1.6-alpha.1 (renderer-v2; not yet declared supported)` before the declaration lands, all green after.
- No functional change: 0.1.6 leaves the mobile-facing contracts untouched (verified upstream: `ui-layout` `src/` unchanged, `client/modules/src/client/system.ts` unchanged, `ui-sidebar-right` additive, `sidebar.footer.action` byte-identical, webserver `Config` unchanged).

## 0.3.33 - 2026-09-14

- Declare DeepSeek Harness 0.1.5-rc.2-local.5 compatible. The runtime version gate quarantines this plugin — and with it the whole plugin tree the mobile page boots — whenever the running dsh version is absent from `SUPPORTED_DSH_VERSIONS`, so the new version has to be named here **before** the core is deployed to the gateway, not after. The four `peerDependencies` ranges gain it in the same release. No functional change: this release is the version declaration only.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.5 (newly declared).

## 0.3.32 - 2026-09-12

- **Plugins that ship their own phone adaptation now actually get it.** Two different conventions were both called `dshMobile` and only one of them was implemented here. The plugin-side one — the one `dsh-android-edapp` calls adapter protocol v1, and the one a plugin declares as `export const dshMobile = { css, enhance }` on its client export surface — expects the shell to do the work: mount `data-dsh-mobile` on `<html>`, wrap the declared fragment in `@media (max-width: 767px)` and inject it, and call `enhance` once while the mobile mode is active. What this package implemented instead was the other one, `window.dshMobile = { register, define }`, for user scripts. Nothing read the export surface and nothing ever set `data-dsh-mobile`, so a plugin could ship several hundred lines of phone CSS whose every selector was prefixed `html[data-dsh-mobile]` and have **none of it apply** — the page loaded, the bundle served, `--dump-config` was green, and the phone showed a desktop-assumed layout. Measured on the real mobile page: `data-dsh-mobile` absent, no injected styles, and the untouched panel padding. The shell side now exists (`src/mobile-adapter.ts`): it mounts the attribute for the mobile viewport and restores the previous value on teardown; it discovers declarations by reading the materialized client-module table (`ctx.modules.loadCache`) because a client bundle is lazy and its export surface only exists once that module materializes — hence a periodic rescan rather than a one-shot probe, with a re-materialized record (HMR) retiring the previous styles and enhancer before the new declaration is applied; it injects each fragment wrapped in the protocol's media query and marked `data-plugin`, which is required rather than cosmetic — `claimStyles` adopts every unmarked `<style>` for whichever module materializes next, and the HMR driver then removes it with that module; and it runs each `enhance` for the mobile mode, keeps the declaration object as the receiver, and calls the returned disposer when the mode ends. A throwing enhancer leaves no disposer behind instead of taking the shell and every later plugin down with it. Verified in a container testbed against `dsh-memory-evolve` on an iPhone-13 viewport: the attribute is mounted, one `CSSMediaRule` with condition `(max-width: 767px)` carries the plugin's rules, the plugin's `enhance` has injected its composer button, and the panels now report the plugin's own mobile padding (`.mt-panel` `6px 8px 12px` with `8px` gaps, `.me-panel` `4px 6px 20px` with `14px` gaps) with zero horizontally clipped elements.
- **The session tab strip stays one line per tab.** The core strip is a single flex row sized for the two or three tabs a desktop session has; with the nine-plus tabs this package's plugins add, a phone squeezed each button to 13px and every CJK label broke *inside* its button — the strip read as `对` above `话`. Each tab is now pinned to its natural width with `white-space: nowrap` and the desktop 36px gap is halved, so the labels stay legible and the strip scrolls, which it already could. Measured on the real page: 13×23px buttons wrapping their labels before, 26×23px (119px for the longest label) on one line after, with the strip scrolling.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.4 (already in the declared peer ranges).

## 0.3.31 - 2026-09-12

- **Closing the right surface no longer strands it.** The dedicated layout only *mirrors* the right surface's own report of whether it is showing, so dismissing the drawer flipped that mirror and nothing else: the module that owns the expanded state stayed expanded and never reported again, because for it nothing had changed. On a phone the panel is fullscreen, and that module reconciles the frame's `canShow` only while it is not (`shown && !fullscreen && !canShow` — a fullscreen panel is not the frame's to collapse), so the two states stayed split: the drawer was hidden while its owner still believed it was showing. The damage lands on the panel's way back — the conversation header control that renders **only while the panel is collapsed** — so after the system back gesture (0.3.29's `__dshMobileHandleBack`) the file drawer could not be opened again; reproduced on the real page, which the old build left in exactly that state. The dismissal now asks that owner to collapse, i.e. the same action the panel's own collapse control performs, and the mirror-only close remains the fallback for a page where the owner never loaded. The scrim takes the same path, since tapping beside the panel does reach it on a phone: the drawer is 94vw wide, so a strip of scrim stays exposed.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.4 (already in the declared peer ranges).

## 0.3.30 - 2026-09-12

- **Enter inserts a line break on a soft keyboard.** The composer's keymap owns exactly two Enter gestures: plain Enter submits, Shift+Enter breaks the line — and a soft keyboard has no Shift, so on a phone the newline was unreachable and the only way to write a two-line message was to send the first line. The native surface now claims a plain Enter in the capture phase while the input mode is touch and asks for the line break through the input pipeline: `beforeinput`/`insertLineBreak` on `[data-composer-input]`, the editor root the composer owns. Measured against a trusted Shift+Enter in the real page, both land identically (`AAA\nBBB`, one `<br>` between the two text spans). A page without the `InputEvent` constructor keeps the desktop gesture rather than swallowing Enter. Every chord keeps its desktop meaning (Shift/Ctrl/Cmd/Alt+Enter pass through untouched, Ctrl/Cmd+Enter still submits), an IME-closing Enter is still the candidate pick rather than a gesture this page may reinterpret, and the Send button is unaffected. Once a physical keyboard has been observed (the surface already tracks Tab/arrow presses) the desktop gesture comes back. The editor root also carries `enterkeyhint="enter"` while in touch mode, so the keyboard's own key is labelled as the line break it now performs.
- **The system back gesture now acts on the surface instead of leaving the page.** The Android back gesture reaches the Activity, not the WebView, so it never touched the page: overlays the user opened stayed open and the gesture fell through to whatever the host app did with it. The surface now publishes `window.__dshMobileHandleBack()`, which closes the topmost mobile overlay from the live layout snapshot — the workspace drawer first (it sits above everything), then the right surface — and returns whether it closed anything; the host app calls it before falling back to its own WebView history or to exiting. It is answered from the layout controller, so it cannot disagree with what is on screen, and the handler is removed with the layout that owns it (a disposed surface never answers). Requires the Flutter host app to forward the gesture (dsh-mobile-flutter 0.5.1+96); an app that does not call it is unaffected.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.4 (already in the declared peer ranges).

## 0.3.29 - 2026-09-12

- Broken first attempt at the line break, superseded by 0.3.30 within the hour; install 0.3.30 or later. It claimed the plain Enter correctly (Enter stopped submitting) but replayed it as a **synthetic Shift+Enter keydown**, which the composer editor drops as an untrusted event, so Enter produced nothing at all instead of a newline. Measured on the real page: the replay left `AAABBB` with no break. The `window.__dshMobileHandleBack()` half of 0.3.29 is unchanged in 0.3.30.

## 0.3.28 - 2026-09-12

- Declare DeepSeek Harness 0.1.5-rc.2-local.4 compatible, because that release is where the phone's file panel actually starts working. The runtime version gate quarantines this plugin — and with it the whole plugin tree the mobile page boots — whenever the running dsh version is absent from `SUPPORTED_DSH_VERSIONS`, so the new version has to be named here **before** it is deployed to the gateway, not after. The four `peerDependencies` ranges gain it in the same release.
- That dsh release carries the fix for the failure this plugin spent 0.3.25–0.3.27 reporting. `protocolOf()` in `@deepseek-ai/dsh-client-resources` derived the resource type from `new URL(address).hostname`, and the target WebView (Huawei NOH-AL10, Android 12) parses a non-special scheme as cannot-be-a-base, so `hostname` is empty and **every** `dsh-resource://…` address reads as protocol `undefined` → registry status `none` → 「文件资源服务不可用。」, with no JavaScript error anywhere and no server-side symptom. Node and desktop Chromium answer `hostname: 'file'` for the same address, which is why the panel only ever failed on the phone. The fix reads the authority as a string instead, with a regression test that stubs a URL whose host is empty. Verified on the real device: the file opens.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.4 (newly declared).

## 0.3.27 - 2026-09-12

- Report the loader rows themselves, because that is where the missing `file` provider hides. A real phone page (Huawei NOH-AL10, Android 12, Chrome 114) reported the whole picture in 0.3.26 and it rules out everything server-side: `resources`, `remote` and `remote.workspaceFiles` are **all present**, `@deepseek-ai/dsh-api-workspace-files` **is** in the boot graph (58 entries), the host app's compat script did supply `Iterator` / `Promise.try` / `Promise.withResolvers` / `Math.sumPrecise` / `Uint8Array.fromBase64` / `Array.prototype.at` — and yet both the session-scoped and the session-less probe address answer `none`, with "文件资源服务不可用。" on screen. So the plugin that registers the provider is not doing it, even though every service it injects exists. The page now also reports `ctx.loader.entries()`: how many rows exist, and every row that is not `active` together with the injected services it is still waiting for. That is the one thing the boot audit cannot surface — `bootClient` runs `assertEntriesActive` only **after** `loader.await()`, so a row that never settles leaves the audit unreached and the page happily renders the plugins that did activate. It also reports how this engine's own `new URL()` parses the three resource address forms, since `protocolOf()` answers `undefined` — reported as `none` — for anything the URL parser rejects.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.3 (already in the declared peer ranges).

## 0.3.26 - 2026-09-12

- Make the dedicated mobile page report what it can actually see. A phone page really did report a missing `file` resource provider (2026-09-12T00:54:51Z, web entry `https://[…]:18443`, `frontend: dedicated`) while the same page served to a desktop browser has the provider registered and renders `data-textpreview-state="text"` for the same file — and because "文件资源服务不可用。" comes from a `status === 'none'` read with **no** JavaScript error, the error guard stayed silent and nothing in the log store separated the candidates. The page now sends one `mobile-page-state` report 20s after load carrying everything a server-side view cannot see: which of the three services the provider injects actually exist (`resources`, `remote`, `remote.workspaceFiles` — a missing one parks that plugin silently), the `file` protocol's status for two address forms (session-scoped and session-less), every open preview tab's address, state and status, whether the unavailable line is on screen, the boot `rev` and entry count plus whether `@deepseek-ai/dsh-api-workspace-files` is among them, whether the host app's document-start compat script actually supplied `Iterator` / `Promise.try` / `Promise.withResolvers` / `Math.sumPrecise` / `Uint8Array.fromBase64` / `Array.prototype.at` on that engine, and the user agent. It then reports each new preview tab (`document-preview-tab`) for up to ten minutes, at most five distinct address/state pairs, and every read is guarded: a diagnostic that breaks the page it observes is worse than none.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.3 (already in the declared peer ranges).

## 0.3.25 - 2026-09-12

- Drop the served page's WebView compatibility shim. 0.3.20 injected an `Iterator` shell plus `Promise.try` / `Math.sumPrecise` / `Uint8Array.fromBase64` guards into the mobile `<head>`, which was the right fix while the page had no other source for them — but the Flutter host app already injects the same set, and more (`AbortSignal.any`/`reason`/`throwIfAborted`, `Array.prototype.at`, `Promise.withResolvers`, `structuredClone`, `Iterator`, `Promise.try`, `Uint8Array.fromBase64`, `Math.sumPrecise`), as a document-start user script for the main frame only. Two owners of one contract means the page and the app can drift, and the shim's effect is invisible on any modern engine, so the tested-in-production copy is the app's and the server-side duplicate is gone. The layout tests were inverted accordingly: they now assert the gateway does **not** re-inject these, so a reintroduced copy fails loudly instead of silently.
- Report the one mobile failure that leaves no evidence. A document tab whose resource protocol has no registered provider renders 「文件资源服务不可用。」 and raises **no** JavaScript error, so the core client error guard — which captures `error`, `unhandledrejection` and `securitypolicyviolation` only — stays silent and the phone leaves nothing in the log store (observed 2026-09-12: a report of that panel, with no client-error entry anywhere). The dedicated mobile page now reads the registry directly (`ctx.resources.source(address).getSnapshot().status`, `none` exactly when the protocol has no provider) and, when the `file` protocol stays provider-less across a first check at 15s and a confirming check 30s later, reports `kind: resource-provider-missing`; a page where the whole `resources` service is absent reports `kind: resource-service-missing` instead. Delivery goes to the same-origin `POST /log-ingest` the core guard already uses, with the same envelope fields, the same `X-Log-Token` and `credentials: 'omit'`, and never a query string (a direct entry can carry the process token there). The probe waits for two answers precisely so a client graph that is merely slow to import is not reported, and every failure of its own — no token, blocked request, absent `fetch` — is swallowed: a diagnostic that breaks the page it observes is worse than none.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.3 (already in the declared peer ranges).

## 0.3.23 - 2026-09-11

- Make an open mobile page recover its Session by itself, so the "自动重连中…" (auto-reconnecting) chip clears instead of staying forever. The gateway authenticates with a short-lived **Session Cookie held in memory** plus a persistent device Cookie, so restarting the host — which restarts this gateway in the same process — invalidates every open page's Session while its device Cookie stays valid. From then on every same-origin request answers `401 {"error":"authentication_failed"}`, and the live channel (`/api/remote.mux`) handshake is rejected outright (`HTTP Authentication failed; no valid credentials`); the client only backs off (≤10s) and retries, it never renews, so the indicator never cleared (measured: still there after 240s) even though the page *looked* alive — its drawer and balances were projections rendered before the restart. Only a manual page reload recovered, because that navigation lands on `/mobile-access/login`, whose script POSTs the renew endpoint.
- The injected page bootstrap (previously CSRF-only, still running ahead of the boot manifest) now also drives recovery: a 401 from a same-origin `fetch` triggers one `POST /mobile-access/auth/renew` (coalesced across concurrent failures and rate-limited to once per 3s) and then replays that request once; a WebSocket handshake `error` triggers one renew, and the client's own ≤10s retry then carries the new Session; a 401 from renew itself (device revoked or expired) falls back to `location.replace('/mobile-access/login?return=…')`, exactly what the login landing already does. Recovery is failure-driven by design — a periodic renew would mint a Session and rewrite the device store on disk on every tick while the Session is perfectly alive.
- Move the gateway tests' fixed listener ports out of the kernel's ephemeral range (`38080/38081` → `61980/61981`). The host runs long-lived tunnels (`dsh-v6-front` forks a socat per connection) whose *outbound* sockets take ephemeral ports, so a phone connection parked on 38080 made every bind in `gateway.test.ts` fail with `EADDRINUSE` — 27 tests failing for a reason that had nothing to do with the code under test.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.3 (already in the declared peer ranges).

## 0.3.24 - 2026-09-11

- Stop the served mobile page from downloading the whole client payload twice. Upstream declares `<link rel="preload" as="script" href="/plugins/??…">` for the one combined client bundle it is about to execute, but this gateway replaces that bundle with its own content-addressed batch (`/mobile-access/mobile-boot/<hash>.js`), so the preload was never consumed — Chromium logged "preloaded using link preload but not used within a few seconds from the window's load event". Measured on a real phone-sized page (Playwright, iPhone 13): the preload still transferred **4.5 MB** (initiator `link`) alongside the **4.07 MB** batch. The rewrite now strips that preload link; other preloads on the page are left untouched. Re-pointing it at the batch was rejected deliberately: an `as=script` preload without `crossorigin` fetches in no-CORS mode while a module script fetch is CORS-mode, so it can never be reused for a module.

## 0.3.22 - 2026-09-11

- Composer toolbar back to one row on a phone. The native surface used to force a permanent two-row layout (`[data-dsh-mobile-composer-trailing] { flex:1 1 100% }` plus a stretched model trigger), which was written when the model trigger kept a visible name at any width. DeepSeek Harness 0.1.5 added its own container-query icon-only floor for that trigger (`@container (width<=360px)` in ui-model-selection hides the label and shows the Models glyph), so the forced row was now self-defeating: the trigger rendered icon-only **and** stretched to ~230px of empty pill, which both wrapped the row and consumed the width the dock cards above the composer need. The toolbar now keeps every group at its natural size, packs the trailing group to the right on the same line, and lets core's own wrap be the fallback for tablets where the label is visible.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.3 (already in the declared peer ranges).

## 0.3.21 - 2026-09-11

- Fix the empty session list in the mobile drawer. The dedicated mobile layout **replaces** the stock `@deepseek-ai/dsh-client-ui-layout` module, and that stock module also publishes a root hook source — `ctx.slots.provideRoot({ hooks: { panelInfo } })`. The slot runtime materializes each root hook source into the standard prop `use<Name>` on every descendant entry, so ui-sidebar's panel rows and session tree read it as `usePanelInfo`. The mobile layout registered its `root` slot without that contribution, so descendants received `undefined`; DeepSeek Harness 0.1.5's ui-sidebar started calling it, and the whole `sidebar.workspaces` entry threw `TypeError: usePanelInfo is not a function`. Symptom: the phone's drawer kept "new session / balance / settings" but rendered no sessions, while the page reported no HTTP error and no error outside the crashed slot. The layout now provides the hook itself, feeding the mobile controller's selected panel through `activePanelId` with a snapshot that keeps its identity until the selection changes (`useSyncExternalStore` compares with `Object.is`; a fresh object per read spins the renderer).
- Repair three test expectations that still used the pre-scope client module id `dsh-mobile`: the module id must equal its npm package name, so `rewriteMobileIndex`'s inject rewrite (and the bundle-patch row) had silently stopped being covered since the scoping commit. Add a regression test asserting that `apply()` publishes the root `panelInfo` contribution and that its snapshot/notification contract holds.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.3 (already in the declared peer ranges).

## 0.3.20 - 2026-09-11

- Inject a WebView compatibility script into the served mobile page's `<head>`, ahead of the boot manifest, so it runs before every client module bundle. Reason: DeepSeek Harness 0.1.5 added the client plugin `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`, whose bundled `yaml` library probes `typeof Iterator.prototype.join` with no guard. An engine without the `Iterator` global (Android WebView / Chrome < 122) throws `ReferenceError: Iterator is not defined` while the client module graph is being imported, and because DSH imports client plugins one by one, that single failure takes the **whole** client plugin graph down — the phone showed only the error-guard fallback screen (`Failed to load plugins`). Desktop Chromium has the global, so desktop testing never reproduced it.
- `Iterator` is installed as an empty shell with **no** `join`, deliberately: leaving `join` undefined keeps the upstream probe true, so the bundled `yaml` still installs its own polyfill — identical to a modern engine, and upstream semantics stay untouched. The script additionally shims `Promise.try` (Chrome 128+), `Math.sumPrecise` (137+) and `Uint8Array.fromBase64` (140+), which the bundled pdfjs in that same plugin reaches on its lazy PDF-preview paths; `Float16Array` is feature-detected by pdfjs itself. Every block is `typeof`-guarded and wrapped in `catch`, so a modern engine is unaffected and the script is idempotent.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.3 (already in the declared peer ranges).

## 0.3.15 - 2026-09-09

- Keep the proxied `/plugins/events` SSE channel alive: the gateway applied its idle upstream socket timeout (`upstreamTimeoutMs`) to streamed responses, so a long-lived SSE with no events was destroyed at that deadline — the client saw `ERR_INCOMPLETE_CHUNKED_ENCODING` (production: every 300s) and the mobile app reloaded the whole page. Streaming (`text/event-stream`) responses now clear that timeout after the response headers arrive, matching the WebSocket branch, while session expiry and client disconnect still bound the connection.
- Stop compressing `text/event-stream` responses: the gzip transform buffers small frames (a handshake frame plus one event produced zero bytes for the client within 8s), which silently swallowed `/plugins/events` frames and left the channel with no traffic at all.
- Verify compatibility with DeepSeek Harness 0.1.2-alpha.4-local.1 (added to the declared peer ranges).

## 0.3.14 - 2026-09-05

- Add an opt-in `allowIpLiteralHosts` switch to the `mobile-access` plugin config (off by default). When enabled, the gateway's external-trust policy (`RequestTrustPolicy`) also accepts requests whose Host header (and, for browser mutations, same-origin requests whose Origin) has an IP-literal hostname — IPv4 or IPv6 — on the bound listener port. Rationale: the public IPv6 direct-connect entry `https://[公网IPv6]:18443/18452` carries a dynamic SLAAC address that cannot be pre-registered in `publicAuthorities`, and without this switch those requests 403 `forbidden` on the exact-Host check. IP literals never go through DNS, so the DNS-rebinding protection the exact-Host check exists for is not weakened; socket CIDR and session/pairing auth still gate every request.
- (previous 0.3.14 unreleased items below)

## 0.3.14 - 2026-09-04

- Add an opt-in Service Worker static cache for the mobile page (`staticCacheWorker` in the `mobile-access` plugin config; off by default). Some WebView engines (observed: Huawei ArkWeb on Android 12) do not persist the gateway's large gzip/chunked responses in the HTTP disk cache, so every page entry re-downloaded the full plugin combo, Vite assets and the mobile boot batch (measured: the same content-addressed URLs fetched with full 200s on every one of 21 entries in a day, including 3-4 duplicate in-flight fetches of the same URL in a single load). When enabled, the rewritten mobile index registers a gateway-served worker (`/mobile-access/sw.js`, scope `/`) that answers revisioned `/plugins/*`, `/assets/*` and `/mobile-access/mobile-boot/*` GETs from Cache Storage — independent of the engine HTTP cache — with single-flight coalescing for duplicate requests, and prunes entries older than one week after each successful navigation. Cache entries are keyed by content-addressed URLs, so a hit is never stale.
- The gateway now serves the mobile boot batch (content-addressed 64-hex URL derived from the DSH mobile version and the entry graph) as `private, max-age=31536000, immutable` instead of `private, no-cache`: a different version or graph is a different URL, so long-lived browser caching is safe and removes a per-entry revalidation/redownload of the ~370 KB layout bundle. The ETag is retained for conditional requests.
- (unreleased items carried below)

## 0.3.13 - 2026-09-03

- Follow-up on 0.3.12: the dedicated mobile layout could still leave the native backdrop up after React had closed the drawer. Two hardening changes make the stuck layer structurally impossible:
  - Dedicated-layout detection now keys on the presence of the `dshm` main column instead of the *absence* of a core `_frame` element. The suffix matcher (`classToken` = `endsWith`) could match an unrelated `*_frame` class in some session views, which made the sync treat the dedicated page as the desktop layout, fail to find a sidebar, and return before ever converging the backdrop.
  - In the dedicated layout the native backdrop (`z-235` full-screen dim button) is now always hidden; the drawer open/close and its dim are owned exclusively by the mobile-layout React scrim. The earlier "two state machines" desync class disappears entirely. Non-dedicated (mobile browser on the desktop layout) behaviour is unchanged.
- The gateway now answers `GET /favicon.ico` / `/favicon.png` with 204 before session authorization, so browser/WebView boot-time favicon fetches no longer 401 (they previously surfaced as per-load http-error warnings in the app's log; app-side filtering remains as a second line of defence).
- (unreleased items carried below)

## 0.3.12 - 2026-09-03

- Fix the stuck full-screen dim layer after switching sessions in the dedicated mobile layout ("grey overlay that blocks taps until the app is killed", watchdog-verified: `.dshm-scrim` open / `.dsh-native-mobile-backdrop` visible with nothing left to close it). Root cause: the native mobile surface's mutation-driven sync tagged the `dshm` drawer container as its own sidebar and re-wrote the drawer's `data-open` attribute from the core sidebar's collapse class, creating two competing state machines (React layout vs native CSS panel) that could desync and leave the backdrop/panel up after React had already closed the drawer. The sync also depended on an uninterrupted mutation → rAF chain.
  - In the dedicated layout the sync no longer overwrites the drawer's `data-open` (the React layout owns it exclusively; the native panel CSS now follows React directly).
  - The native backdrop now hides whenever React reports the drawer closed (`data-open` on the scrim), instead of waiting for the core sidebar's 150 ms collapse settle, and no longer depends on a continuously healthy observer chain (2 s safety heartbeat re-runs the idempotent sync).
  - Tapping the backdrop now closes through the React path first (scrim click); the core-toggle fallback only applies on non-dedicated surfaces.
- (unreleased items carried below)

## 0.3.11 - 2026-09-03

- Relax the gateway CSP from `base-uri 'none'` to `base-uri 'self'`: the DSH core `frontend-static` injects a same-origin `<base href="/">` into the served index (SPA deep-link asset anchoring), so the old policy made every page load raise a `securitypolicyviolation`. The page error guard queued each violation and retried delivery every 5 s; on direct-gateway connections (no nginx relay) every attempt 403'd forever, flooding the mobile app's http-error log and losing client-error telemetry. A same-origin base adds no XSS surface.
- Add an unauthenticated-by-token `POST /log-ingest` passthrough route on the gateway (`X-Log-Token` allowlist identical to the public nginx relay: deployment token and page token). Direct-gateway pages now forward page error-guard reports to the same local logstash HTTP channel the nginx 18447 tunnel uses, so queued client errors drain instead of retrying 403 every 5 s.
- (unreleased items carried below)

## 0.3.10 - 2026-09-02

- Support the DSH 0.1.2-alpha.4 web frontend on mobile: its settings module no longer injects the connection client, so the gateway now appends the connection client to the settings dependency graph instead of failing the mobile index rewrite (which previously surfaced as an `upstream_unavailable` 502 right after pairing).
- When an upstream index rewrite still cannot be completed, relay the raw upstream page instead of answering 502, so a paired mobile session always lands on something usable and the failure stays visible in gateway logs.

## Unreleased


- Inject `AbortSignal.any` and `Promise.withResolvers` boot polyfills into gateway documents, so old Android System WebView releases (e.g. Chrome 114 on Android 12) can start the DSH connection instead of failing before the client bundle runs.

## 0.3.2 - 2026-08-29

- Special thanks to @JackRushante for [#16](https://github.com/saya-ch/dsh-mobile/pull/16): the secure Android media bridge, image attachments, localization foundation, bounded extension requests, and Funnel lifecycle hardening. This release retains all four original commits and their author metadata.
- Move image selection and camera capture into a dedicated top row of the composer command menu, without focusing the message editor.
- Push extension and `/mobile` changes to authenticated phones immediately, while retaining bounded polling as a network-recovery fallback.
- Bind each mobile UI to its matching Host, script, style, and asset generation; retain the previous Host through a bounded refresh window, fail closed on client activation errors, and tighten scoped requests against encoded path traversal.
- Bound long-running Android picker and camera interactions, release temporary provider grants across success, cancellation, timeout, rotation, and Activity teardown, and retain compatibility with supported WebView releases.
- Split mobile language dictionaries into dedicated modules; make native Android screens follow the system locale in Simplified Chinese, English, or Italian; make plugin-owned Web UI follow DSH's selected locale; and retain Italian resources for future DSH support.
- Correct the mobile extension and Funnel documentation, and record the Android runtime libraries shipped with the app.

## 0.3.1 - 2026-08-28

- Credit @BlueandwhiteXD ([#15](https://github.com/saya-ch/dsh-mobile/pull/15)) for the Android keyboard inset report and fix incorporated into the 0.3 mobile layout.

## 0.3.0 - 2026-08-28

- Add one-click connection diagnostics for versions, LAN gateway, network interface, Windows firewall, and the selected remote provider, with a sanitized report for support requests.
- Publish compatibility metadata separately from the stable discovery protocol so the Android app can distinguish app, plugin, and protocol mismatches.
- Keep the connection chooser interactive during background restoration, race saved LAN and remote trust, reuse trust after remote address changes, apply remote-aware timeouts and single-flight refresh backoff, and privately cache revisioned assets for faster reopening.
- Preserve fallback discovery when Android 13+ nearby Wi-Fi permission is declined, and provide concise guidance for QR, pairing, session, rate-limit, and service failures.
- Forward authenticated DSH and plugin mutations with CSRF protection, restoring mobile plugin-market and other non-GET actions.
- Coordinate Android and Web status-bar and safe-area behavior, keep settings actions readable on narrow screens, and refresh the app icon.
- Support DeepSeek Harness 0.1.2-alpha.1, including its `/api/remote.mux` state channel and batched renderer boot, so Workspaces, model selection, sessions, and community plugins remain available on mobile.
- Compress dedicated mobile boot batches and harden Android WebView origin checks, reducing remote startup transfer while avoiding background-thread WebView access.

## 0.2.2 - 2026-08-27

- Detect LAN and remote pairing links automatically after a QR scan, independent of the currently selected connection page.
- Clarify QR, network, firewall, certificate, and pairing failures so users can identify the shortest recovery path.

## 0.2.1 - 2026-08-25

- Add a stable Android app download entry to the desktop Mobile Access panel.

## 0.2.0 - 2026-08-24

- Add independent LAN and remote access flows with separate paired-device stores.
- Add optional Tailscale Funnel and managed cpolar remote providers.
- Restore saved Android connections automatically and improve mobile loading over limited links.
- Page older session history on demand and compress eligible gateway responses.
- Build the pinned Funnel host from source and publish checksums, an SBOM, and third-party notices.

## 0.1.4 - 2026-08-23

- Keep the plugin compatible with DeepSeek Harness 0.1.1.
- Continue mobile layout, safe-area, composer, settings, and interaction improvements.
- Restore bounded native response reads on Android 10 through 12.
- Publish Android releases as reproducible, signed release builds instead of temporary debug builds.
- Preserve the existing mobile protocol so older app builds can continue using the updated plugin; switching from the previous temporary Android signature requires one uninstall and re-pair.
- Refresh CI actions, Android lint coverage, build tooling, and maintenance documentation.

## 0.1.3 - 2026-08-23

- Added DeepSeek Harness 0.1.1 compatibility.
- Improved mobile layout and interaction behavior.
