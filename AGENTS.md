# AGENTS.md — dsh-mobile

## 项目定位

DSH 社区插件 `@feiyueve/dsh-mobile`（fork 自上游 `saya-ch/dsh-mobile`，`package.json` 的 repository 字段仍指上游）：把电脑里的 DSH Web UI 以移动形态服务给手机浏览器与 Android App，不改 dsh 源码。

- **Host 半边**：认证 LAN 网关——**单账号账密登录 + 一个月 token**（`src/account.ts` 是唯一凭据来源；同一枚 token 两种形态：原生 API 走 `Authorization: Bearer`，WebView 走同名 cookie `dsh_ma_session`，变更请求再带 `dsh_ma_csrf`/`x-dsh-mobile-csrf`）、回环代理到 3080、移动 index 重写（viewport/去上游 preload/boot 批次）、CSP/缓存/Service Worker。**配对模式已整体删除**：`AccessController`（配对窗/设备表/短会话/续期）、`src/storage.ts`、`PAIR_PAGE`/`PAIR_SCRIPT`、`auth/pair`·`auth/renew`·`mobile-access/pair(.js)`、管理面 `pairing/open`·`devices*` 全没了，`src/access.ts` 只剩被账号链路复用的 `AccessError`/`SessionAuthorization`/`BoundedRateLimiter`（`src/access.ts:14/21/33`）；`/mobile-access/login` 现在是**账密表单页**。**401/WS 失败不再续期重放**——SPA bootstrap 改成「401 → 导到账密登录页（带 `return` 回跳）」（`src/gateway.ts:150-160` 的实现说明）。
- **Client 半边**：专用移动布局（**替换**官方 `@deepseek-ai/dsh-client-ui-layout` 模块）+ native surface + 设计系统。
- 生态：dsh 核心 `../deepseek-harness/`；Flutter 重写版 App `../dsh-mobile-flutter/`（独立仓库，工作区 APK 链路当前分发的是它）。`docs/backstop-design.md` 的「后盾」是 **App 原生层**（监控/自救）设计、P1 未开工，与 `native/funnel-host` 无关。

## 仓库与状态

| 项 | 事实 |
|---|---|
| git | 唯一 remote `origin=git@github.com:FeiyuEVE/dsh-mobile.git`（无 upstream；`origin/HEAD→origin/main`）；当前分支 `local/hot-update`（非 main，`ca434f7` = 内容热更两条只读路由，已发私源 0.3.45；它是从 `local/sse-keepalive` 续开的，后者全部提交都在本分支里、但本身仍未并入 main）；无 tag |
| 包 | `@feiyueve/dsh-mobile@0.3.45`，Apache-2.0，`private:false`，Node `^22.19.0 \|\| >=24.0.0` |
| 发布 | 私源（`~/.npmrc`：`@feiyueve` → `http://npm.192.168.0.240.nip.io/`）；本 fork 只发私源。`0.3.45` **已发私源**（2026-10-13 `npm publish` → `dist-tags.latest = 0.3.45`、`next = 0.3.38`；tarball `/-/dsh-mobile-0.3.45.tgz`，sha256 `18afa97faad44a1ca170182baacae77bfea75a1f9f8d4c66dbd84e42819ce335`，12.8 MB）。**0.3.45 = 内容热更两条只读前缀**（`src/hot-update.ts` 新增，见下方准则 14）：`GET /mobile-access/app-assets/<逻辑名>` 供 App 的 Dart 侧 `RemoteAssets` 取页面资源树，`POST /mobile-access/codepush/{check,events}` + `GET /mobile-access/codepush/download/<file>` 供设备里的 libupdater（经 App 回环中继）取 Dart 补丁；**不新增服务、不新增端口**，读 `hotUpdateDir`/`codePushDir`（默认 `<accountDir>/{hotupdate,codepush}`），与 18443/18452 同一条账号 token 鉴权面。判据：`npm run verify` 退出 0、**282 例**（`tests/gateway.test.ts` 新增 11 例）；容器测试台（dsh `0.2.1-alpha.1-local.1` + 本插件）**20/20 探针全过**、安装物与私源 tarball `diff -r` 逐文件一致。**0.3.44 = 共享账号表下的写回竞态修复 + 撤销接口 fail-closed**（关闭路径锁内强制重读盘、指纹计入 ino、陈旧锁删不掉时按 deadline 收口；`/auth/tokens/revoke` 只认 `id`/`all`/`self`，拼错的键不再静默撤销调用方自己——时间戳级取证与修法见 `CHANGELOG.md`）——**这条修的是三服共用 `tokens.json` 时「撤销被别服关闭时的整表写回抹掉 / 调用方把自己踢下线」**。**0.3.43 = 账号表可跨 uid 共用**（`accountFileMode` + 读方 chmod 容忍 EPERM，见 `CHANGELOG.md`）：自助服跑 root、正式服/测试服跑 feiyueve，读同一份 `~/.dsh/mobile-access/{account,tokens}.json`。**安装口径（2026-10-11 用户拍板后改）**：**先发私源 → 再从私源装**，装在 profile 里用 **`pnpm install`**（profile 是 pnpm 布局、`link:` 是 pnpm 语法，`npm install` 必然 EUNSUPPORTEDPROTOCOL），装完与私源产物 `diff -r` 对账。**旧的 `npm pack` + `tar -xzf` 手工解包口径已废**——它绕过包管理器，会让 `pnpm-lock.yaml` 与实际安装漂移（修前两台 profile 的 lockfile 还停在 `0.3.38`，实际装的已是 `0.3.42`；修后两份 lockfile 都记 `@feiyueve/dsh-mobile@0.3.42`）。旧版备份 `/home/feiyueve/tmp/dsh-mobile-installed-backup/`，整棵 profile 备份 `/home/feiyueve/tmp/dsh-profile-backup-*/` |
| 装载 | web 网关 18443（upstream 3080）、staging 18452（upstream 3081），端口在各自 profile 的 `cordis.patch.yml`（仓库内该文件默认 `127.0.0.1:3443`）；profile 依赖按各自节奏升级——**以 `~/.dsh/profiles/*/package.json` 为准**（**2026-10-13 快照：web / staging 已 pin 并装 `0.3.45`**——staging 已重启生效，**三个真实入口各 9 项免凭据探针全过**（LAN `192.168.0.240:18452`、公网 v4 `139.199.186.70:18452`、IPv6 直连 `[2409:8a4c:d18:a4f0:6e0b:84ff:fe81:d392]:18452`；判据见下方准则 14）；**web 已 pin 并装 0.3.45、待重启生效**——重启前探针呈「`metadata` 报 0.3.44 + 两条新前缀 404」，与重启后形成对照；**rescue 仍是 `0.3.44`**（root 红线，升级需人工）；三服共用一份账号表：`accountDir` 指 `~/.dsh/mobile-access`（**rescue 用绝对路径**——`dshHomePath` 在 rescue 下是 `/root/.dsh`）、`accountFileMode: 0o640`、目录 setgid 到共享组 `dsh-shared`，网关/CA 私钥仍 0600）。**0.3.42 = 三服统一鉴权**：账号与令牌表可跨 profile 共享（配置项 `accountDir`，staging 的 `cordis.patch.yml` 配成 `!!js dshHomePath('mobile-access')` 与 web 同一份），并带跨进程读改写锁 + 「改密 = 标记全部撤销」——**任服登录，两服都认**（实测：web 登录的 token 打 staging 200/22 条，staging 登录的 token 打 web 200/995 条）。**别拿 \`~/.dsh/mobile-access/tokens.json\` 当只读缓存**：老版本插件（<0.3.42）会用自己那份陈旧内存表整表覆盖，把别服刚签发的 token 抹掉 |
| Android | **已退役（2026-10-11）**：原 Kotlin WebView 壳 App（`apps/mobile/`，`io.github.sayach.dshmobile`）已随账密登录改造整体删除——它的 `NativeAuthClient.pair/renew` 打的是已下线的配对端点（实测 404），且工作区不再分发它。Android 客户端见 `../dsh-mobile-flutter/`（Flutter 版，独立仓库） |

## 目录结构

| 路径 | 职责 |
|---|---|
| `src/plugin.ts` | Cordis 入口（`name=dsh-mobile`，`inject=[webServer,commands,connection]`）、`/api/mobile-access/*` 管理面、`/mobile` 命令 |
| `src/gateway.ts` | 网关核心：`/mobile-access/*` 路由（**账密登录页 `/login` + `/login.js`**、`auth/login`·`auth/session`·`auth/tokens`·`auth/tokens/revoke`·`auth/logout`、公开的 `metadata`（回 `accountConfigured`）与 `discovery`（回 `instanceId`）、**需账号 token 的 App 分发 `/app/{manifest.json,*.apk}`**、设备/token 列表）、index 重写（viewport/preload/boot 批次）、CSP、SSE/WS 代理 |
| `src/hot-update.ts` | **内容热更的两条只读前缀**（0.3.45；见准则 14）：`APP_ASSETS_PREFIX` = `/mobile-access/app-assets`（页面资源树，`manifest.json` + 逻辑名镜像，读 `hotUpdateDir`）、`CODE_PUSH_PREFIX` = `/mobile-access/codepush`（`check`/`events` 两个 POST + `/download/<file>` 静态字节，读 `codePushDir/index.json`）。名字白名单与 App 侧 `remote_assets.dart` 的 `_safeNameRe` 同源；目录不存在/名字非法/文件缺失一律 **404（不是 5xx）** |
| `src/client.ts`·`mobile-layout.ts`·`native-mobile.ts` | Client 半边：移动布局、消息、native surface CSS/同步 |
| `src/config.ts`·`account.ts`·`access.ts`·`control.ts`·`network.ts`·`http-security.ts` | 配置校验与资源上限、**账号与 token 表（`account.ts`，唯一凭据来源；快照上限 `tokenSnapshotLimit(maxTokens) = maxTokens + 64`）**、会话授权原语（`access.ts` 只剩 `AccessError`/`SessionAuthorization`/`BoundedRateLimiter`；**`storage.ts` 已删**）、CIDR、CSRF 与 loopback 信任策略 |
| `src/funnel.ts`·`cpolar*.ts`·`remote.ts`·`diagnostics.ts`·`extensions.ts` | 远程通道、诊断、扩展注册表 |
| `src/cli.ts` | `dsh-mobile` bin：`setup [--address\|--port 3443\|--dsh-port 3080\|--no-firewall]`、`purge --yes`、`extension create <id>` |
| `tests/` | vitest（`vitest.config.ts` include 仅 `tests/**/*.test.ts`）；`tests/*.test.js`·`.d.ts`·`.map` 是陈旧 tsc 副产物（多数已跟踪），勿改 |
| `apps/mobile/` | **已删除（2026-10-11）**：原 Kotlin WebView 壳 App（Gradle 工程）；Android 客户端已迁到 `../dsh-mobile-flutter/` |
| `native/funnel-host` | Go/tsnet 的 Tailscale Funnel 托管宿主（Windows x64；产物在根 `bin/`，`.exe`≈22MB） |
| `scripts/*.mjs` | `check-release-version`、`check-mobile-release`、`check-dsh-compatibility`、`build-funnel-host`、`clean` |
| `cordis.patch.yml` | bundle patch：插入移动网关 host 行 + 目录选择器 host/client 行 |

## 常用命令

```sh
pnpm install              # 唯一可用的安装路径：devDeps 用 pnpm 的 link: + pnpm-workspace.yaml overrides
npm run verify            # check:version + check:mobile-release + typecheck + test + build + npm pack --dry-run
npm run typecheck         # = tsc --noEmit（lint 同命令）
npm run test              # vitest run --pool=threads --maxWorkers=1（串行；仅 tests/**/*.test.ts）
npm run build             # tsdown → lib/{index.mjs,cli.js,client.js,mobile-layout.js}
node scripts/check-dsh-compatibility.mjs ../deepseek-harness   # 亦认 DSH_SOURCE_ROOT；--contract-only 跳过「已声明」门
npm run build:funnel-host # 需 Go 1.26.6，产出 bin/dsh-mobile-funnel-win32-x64.exe
```

## 约定与准则

1. **客户端 bundle id 必须等于 npm 包名**：`__ModuleLoader__.load({id})` 由 `tsdown.config.ts` 从 package.json 派生；`mobile-layout.js` 那份**故意**注册 `@deepseek-ai/dsh-client-ui-layout`（覆盖官方模块）。不一致会让**整棵客户端插件图**崩成 `Failed to load plugins`。
2. **HTTP 级验证不算数**：页面 200 + bundle 200 + `--dump-config` 全挂载仍可能一个都渲染不出。改 Client 半边必须真浏览器跑 `../scratch-release/e2e/`（`conversation.cjs` 桌面、`mobile.cjs`/`mobile-drawer.cjs` 手机、`run-in-netns.sh` 进容器 netns）。
3. **两处独立的 dsh 版本门必须同步增补**：`package.json` peerDependencies 显式列表 + 运行时 `src/compatibility.ts` 的 `SUPPORTED_DSH_VERSIONS`（现 14 项，末项 `0.1.5-rc.2-local.4`）；后者缺 `-local.N` 会把插件 quarantine，整棵插件树 boot 失败。
4. **依赖必须走工作区源码**：`pnpm-workspace.yaml` overrides 与 devDependencies 的 `link:../deepseek-harness/...`；`@deepseek-ai/cordis` 必须指 `../deepseek-harness/vendor/cordis`（双份 cordis → 类型增强失效、服务身份割裂）。安装一律用 `pnpm install`：npm 不支持 devDeps 的 `link:` 协议（EUNSUPPORTEDPROTOCOL），`package-lock.json` 也未随 `package.json` 同步；`README`/`CONTRIBUTING`/CI 里写的 `npm ci` 照抄会失败。
5. **发版先查号段**：`git log` + `npm view @feiyueve/dsh-mobile versions`，避免同分支多会话撞号。`.github/workflows/release.yml` 是上游链路（`registry.npmjs.org` + 无 scope 包名 `dsh-mobile`），与本 fork 的私源 `@feiyueve/dsh-mobile` 不匹配。
6. **替换官方 `ui-layout` 模块要承接其全部职责**（`provideRoot({hooks:{panelInfo}})`、槽 children、`reflect.provide('layout')`）；每次同步 dsh 都 diff 官方 `packages/client/ui-layout/src/client/index.ts`，漏掉会让抽屉会话列表为空。
7. **WebView 兼容垫片归 App 独占**：服务端不再注入这些垫片，`tests/mobile-layout.test.ts` 的反向断言是哨兵，**禁止加回**。
8. **管理面与网关访问**：`/api/mobile-access/*` 全部经 `assertLocalAdminTrust`（仅 loopback + 同源 + Host 回环）；经 docker 端口映射从宿主访问时源 IP 是网桥网关 → 403，容器里须 `run-in-netns.sh`。网关 18443/18452 对非移动/**未登录**（或凭据不认）请求返回 401/403。
9. **`check:mobile-release` 覆盖**：funnel `go.mod`（go 1.26.6 / tailscale v1.102.3）+ `bin/*.exe` MZ 头且 <40MiB、npm `files` 清单（含 `THIRD_PARTY_NOTICES.md`）、以及「插件 UI 不得落独立 locale」哨兵（`dsh-mobile-control-locale` 不得回流）——动这些会红。原先的品牌图标 PNG / Android manifest / Kotlin / 各语言 string 断言已随壳 App 退役删除（2026-10-11）。
10. **凭据不入库**：不提交签名密钥/凭据/令牌（`CONTRIBUTING.md`）。每个拒绝路径要有负向测试。
11. **文档口径陷阱**：本仓库 `README.md` 顶部与兼容性表停在 **0.3.2**（上游口径，勿当现状）；`CHANGELOG.md` 本地事实从 0.3.26 起，且有 0.3.23/0.3.24 顺序颠倒、0.3.14 重复、中段陈旧 `## Unreleased`。
12. **APK 分发链路**：工作区 `~/dsh-apk-dl/` 当前 manifest 指向 **dsh-mobile-flutter** APK；父仓库 `dsh-apk-dl/` 只是服务源码。

13. **日志面已收紧（0.3.41，2026-10-11）——改这块前先读这条**：原先写在源码里的两枚静态令牌（`LOG_QUERY_TOKEN` / `LOG_INGEST_TOKENS` 的「部署令牌」）**都不在了**，谁拿到 APK / 仓库就能读日志、写 ES 的存量洞已堵上。现在的凭据模型：
    - **查询（读）** `GET /api/mobile-logs`：**账号会话**（Bearer / `dsh_ma_session` cookie），未登录/被踢/过期 → **401**。网关反代到 3080 时注入**进程内随机键**请求头 `x-log-query`（`LOG_QUERY_KEY = randomBytes(32)`，`gateway.ts` 导出），3080 侧插件路由比对同一值——两半同进程，所以键不落盘、不进客户端、**无需轮换**；客户端自带的同名头已在 `sanitizeRequestHeaders` 里移出放行列表，唯一写入点是 `proxyHttp(request, response, authorization, extraUpstreamHeaders)`（写在 sanitize 之后）。代理会话的 `expiresAt` 必须夹到 1 小时：30 天 token 的真实值超出 `setTimeout` 的 32 位毫秒上限，会被 Node 截断成 1ms 直接断连。
    - **页面守护上报（写）** `POST /log-ingest`：**只认页面令牌** `dshm-page-ingest-…`（部署经 profile 的 `ingestPageToken` 注入为 `__DSH_INGEST_TOKEN__`，只有登录后的页面拿得到）。常量是 `gateway.ts` 的 `LOG_INGEST_PAGE_TOKEN`。
    - **App 原生上报（写）** `POST /mobile-access/log-report`（0.3.41 新增）：凭账号会话、`text/plain`、≤1 MiB（413）、未登录 401，转发到本机 logstash `127.0.0.1:30080`。`dsh-mobile-flutter` 的 `AppLog` 打的就是这条（未登录停发但保留 ≤60 条队列）。
    - **轮换只需一处**：页面令牌 = profile `ingestPageToken` + frps nginx `dsh-mobile.conf` **三处**白名单（`= /log-ingest`、`/log-ingest/`、`= /rescue-intake/report`）+ supervisor `/usr/local/sbin/dsh-web-supervisor` 的 `PAGE_LOG_TOKEN`。
    - **不要退回静态令牌**：每条拒绝路径都有负向测试（`tests/gateway.test.ts` 的「App 上报只认账号会话」「`/log-ingest` 只认页面令牌」「查询路由要会话 + 只有进程内键能进 3080」）。**旧 App（≤ build 117）** 内置的是已退役的部署令牌 ⇒ 它的 ES 上报与 App 内日志页会失败（本地日志文件不受影响），修法随 build 118 出。

14. **内容热更的两条前缀（0.3.45）——「不重装 APK 也能改手机界面」的家侧落点**：App 侧（`dsh-mobile-flutter`）已经把设备端两半做完（Dart 侧 `RemoteAssets` 取页面资源、引擎侧 libupdater 经 App 的**回环中继**取 Dart 补丁），缺的就是家侧这两个前缀。五条硬约束：
    - **不新增服务、不新增端口**：读的是发布脚本写下的普通目录（`hotUpdateDir` / `codePushDir`，默认 `<accountDir>/{hotupdate,codepush}`，于是三服共用同一份热更内容），四条分发挂在**已有网关**上，与 `/app/*` 分发包同口径**先校账号 token 再读盘**。
    - **补丁协议是冻的**：设备端 updater 编在 `libflutter.so` 里（`shorebirdtech/updater` 的 `network.rs`），只认「`POST check` → `PatchCheckResponse`、`POST events`、`GET download/<file>`」。家侧的权威同形实现是 App 仓库的 `scripts/codepush/publish_patch.py` + `patch_server.py`，**改 `src/hot-update.ts` 必须与它逐条对齐**；`codePushCheckResponse` 的 `rolled_back_patch_numbers` **在没有新补丁时也必须下发**（只回 `patch_available:false` 会让设备继续从被回滚的补丁启动）。
    - **404 而不是 5xx**：内容目录是**可选**的（没发布过就没有），App 侧的设计是「任何失败都回落内置」；把「还没发布」变成 5xx 只会在 App 日志里多一堆吓人的错误。名字一律先过白名单再 resolve 出目录包含校验（白名单正则与 App 侧 `remote_assets.dart` 的 `_safeNameRe` **逐字同源**，不一致会出现「发布出去的包自己带着被客户端静默跳过的条目」）。
    - **验收口径（免凭据即可）**：网关对**路径不存在**的 `/mobile-access/x` 回 **404 `{"error":"not_found"}`**、对**路径存在但要鉴权**的回 **401 `authentication_failed`** —— 所以「匿名打新前缀得到 401 而不是 404」本身就是「路由真的存在且被入口放行」的判据，**不需要为验证造一枚生产凭据**。配合 `GET /mobile-access/metadata` 的 `pluginVersion` 就是三入口探针（脚本在 App 仓库 `scripts/codepush/probe_entries.sh`；落在 `~/.dsh/mobile-access/hotupdate` 的是 `publish_assets.py` 发布的 `manifest.json` + 文件树）。⚠️ **改配置/换插件版本都要重启对应 profile 才生效**，重启前的老进程会照旧 404（这正是「新路由没生效」与「入口拦了」的区分点）。
    - **发布内容**（2026-10-13 首版）：`~/.dsh/mobile-access/hotupdate/` 是 **revision 1 的「与内置一致」基线**（15 个文件、2,169,266 B，`viewer.html` 与 APK 内置副本 sha256 同为 `482027c8…`）——热更链路通着但界面不变；`~/.dsh/mobile-access/codepush/index.json` 是空清单 `{"releases":{}}`（**没有发布任何补丁**，所以设备端只会得到 `patch_available:false`，不会去改主色/标题）。要看「热更真的改界面」的实证，见 App 仓库 `.tmp/codepush/` 的演示内容（**不要把那套演示资源发到这个目录**）。

## 相关文档

- 本目录：`README.md`/`README.en.md`、`CHANGELOG.md`、`SECURITY.md`、`CONTRIBUTING.md`、`design-system/dsh-mobile/MASTER.md`、`docs/backstop-design.md`。
- 父仓库：`../PLUGINS.md`（登记 + 兼容矩阵）、`../CHANGES.md`（dsh 核心改造登记）、`../RESOURCES.md`（18443/18452、frp 隧道、`~/dsh-apk-dl/`）、`../PLUGIN-DEV.md`、`../AGENTS.md`。
