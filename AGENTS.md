# AGENTS.md — dsh-mobile

## 项目定位

DSH 社区插件 `@feiyueve/dsh-mobile`（fork 自上游 `saya-ch/dsh-mobile`，`package.json` 的 repository 字段仍指上游）：把电脑里的 DSH Web UI 以移动形态服务给手机浏览器与 Android App，不改 dsh 源码。

- **Host 半边**：认证 LAN 网关——配对/设备/Session、会话 Cookie 失败驱动续期（HTTP 401 / WS error → renew 后重放）、回环代理到 3080、移动 index 重写（viewport/去上游 preload/boot 批次）、CSP/缓存/Service Worker。
- **Client 半边**：专用移动布局（**替换**官方 `@deepseek-ai/dsh-client-ui-layout` 模块）+ native surface + 设计系统。
- 生态：dsh 核心 `../deepseek-harness/`；Flutter 重写版 App `../dsh-mobile-flutter/`（独立仓库，工作区 APK 链路当前分发的是它）。`docs/backstop-design.md` 的「后盾」是 **App 原生层**（监控/自救）设计、P1 未开工，与 `native/funnel-host` 无关。

## 仓库与状态

| 项 | 事实 |
|---|---|
| git | 唯一 remote `origin=git@github.com:FeiyuEVE/dsh-mobile.git`（无 upstream；`origin/HEAD→origin/main`）；当前分支 `local/sse-keepalive`（非 main）；无 tag |
| 包 | `@feiyueve/dsh-mobile@0.3.28`，Apache-2.0，`private:false`，Node `^22.19.0 \|\| >=24.0.0` |
| 发布 | 私源（`~/.npmrc`：`@feiyueve` → `http://npm.192.168.0.240.nip.io/`）`latest=0.3.28`；本 fork 只发私源 |
| 装载 | web 网关 18443（upstream 3080）、staging 18452（upstream 3081），端口在各自 profile 的 `cordis.patch.yml`（仓库内该文件默认 `127.0.0.1:3443`）；profile 依赖按各自节奏升级（当前 web / staging 均 pin `0.3.27`，以 `~/.dsh/profiles/*/package.json` 为准） |
| Android | `apps/mobile/android`：`io.github.sayach.dshmobile`，minSdk 29 / targetSdk·compileSdk 36；`versionName` 必须等于 package.version，`versionCode` 只需正整数递增（当前 0.3.28 / 63） |

## 目录结构

| 路径 | 职责 |
|---|---|
| `src/plugin.ts` | Cordis 入口（`name=dsh-mobile`，`inject=[webServer,commands,connection]`）、`/api/mobile-access/*` 管理面、`/mobile` 命令 |
| `src/gateway.ts` | 网关核心：`/mobile-access/*` 路由、index 重写（viewport/preload/boot 批次）、CSP、SSE/WS 代理 |
| `src/client.ts`·`mobile-layout.ts`·`native-mobile.ts` | Client 半边：移动布局、消息、native surface CSS/同步 |
| `src/config.ts`·`access.ts`·`control.ts`·`storage.ts`·`network.ts`·`http-security.ts` | 配置校验与资源上限、配对/设备/Session、持久化、CIDR、CSRF 与 loopback 信任策略 |
| `src/funnel.ts`·`cpolar*.ts`·`remote.ts`·`diagnostics.ts`·`extensions.ts` | 远程通道、诊断、扩展注册表 |
| `src/cli.ts` | `dsh-mobile` bin：`setup [--address\|--port 3443\|--dsh-port 3080\|--no-firewall]`、`purge --yes`、`extension create <id>` |
| `tests/` | vitest（`vitest.config.ts` include 仅 `tests/**/*.test.ts`）；`tests/*.test.js`·`.d.ts`·`.map` 是陈旧 tsc 副产物（多数已跟踪），勿改 |
| `apps/mobile/` | `android/`=Kotlin WebView 壳（Gradle 8.11.1 wrapper）；另有 `contract/url-policy-cases.json`、`store/`、`brand/`、`README.zh-CN.md` |
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
cd apps/mobile/android && bash ./gradlew --no-daemon lintDebug testDebugUnitTest assembleDebug -x lintAnalyzeDebugUnitTest -x lintAnalyzeDebugAndroidTest
```

## 约定与准则

1. **客户端 bundle id 必须等于 npm 包名**：`__ModuleLoader__.load({id})` 由 `tsdown.config.ts` 从 package.json 派生；`mobile-layout.js` 那份**故意**注册 `@deepseek-ai/dsh-client-ui-layout`（覆盖官方模块）。不一致会让**整棵客户端插件图**崩成 `Failed to load plugins`。
2. **HTTP 级验证不算数**：页面 200 + bundle 200 + `--dump-config` 全挂载仍可能一个都渲染不出。改 Client 半边必须真浏览器跑 `../scratch-release/e2e/`（`conversation.cjs` 桌面、`mobile.cjs`/`mobile-drawer.cjs` 手机、`run-in-netns.sh` 进容器 netns）。
3. **两处独立的 dsh 版本门必须同步增补**：`package.json` peerDependencies 显式列表 + 运行时 `src/compatibility.ts` 的 `SUPPORTED_DSH_VERSIONS`（现 14 项，末项 `0.1.5-rc.2-local.4`）；后者缺 `-local.N` 会把插件 quarantine，整棵插件树 boot 失败。
4. **依赖必须走工作区源码**：`pnpm-workspace.yaml` overrides 与 devDependencies 的 `link:../deepseek-harness/...`；`@deepseek-ai/cordis` 必须指 `../deepseek-harness/vendor/cordis`（双份 cordis → 类型增强失效、服务身份割裂）。安装一律用 `pnpm install`：npm 不支持 devDeps 的 `link:` 协议（EUNSUPPORTEDPROTOCOL），`package-lock.json` 也未随 `package.json` 同步；`README`/`CONTRIBUTING`/CI 里写的 `npm ci` 照抄会失败。
5. **发版先查号段**：`git log` + `npm view @feiyueve/dsh-mobile versions`，避免同分支多会话撞号。`.github/workflows/release.yml` 是上游链路（`registry.npmjs.org` + 无 scope 包名 `dsh-mobile`），与本 fork 的私源 `@feiyueve/dsh-mobile` 不匹配。
6. **替换官方 `ui-layout` 模块要承接其全部职责**（`provideRoot({hooks:{panelInfo}})`、槽 children、`reflect.provide('layout')`）；每次同步 dsh 都 diff 官方 `packages/client/ui-layout/src/client/index.ts`，漏掉会让抽屉会话列表为空。
7. **WebView 兼容垫片归 App 独占**：服务端不再注入这些垫片，`tests/mobile-layout.test.ts` 的反向断言是哨兵，**禁止加回**。
8. **管理面与网关访问**：`/api/mobile-access/*` 全部经 `assertLocalAdminTrust`（仅 loopback + 同源 + Host 回环）；经 docker 端口映射从宿主访问时源 IP 是网桥网关 → 403，容器里须 `run-in-netns.sh`。网关 18443/18452 对非移动/未配对请求返回 401/403。
9. **`check:mobile-release` 覆盖很宽**：品牌/图标 PNG 尺寸与 alpha（含各密度 mipmap）、Android manifest（禁明文、权限、AndroidKeyStore、CA 固定）、`versionName`==package.version、各语言 string/plurals 对齐、funnel `go.mod`（go 1.26.6 / tailscale v1.102.3）+ `bin/*.exe` MZ 头且 <40MiB、npm `files` 清单——动这些会红。
10. **凭据不入库**：不提交签名密钥/凭据/令牌（`CONTRIBUTING.md`）；稳定版 Android 签名 secrets 只进 CI runner（`release.yml` 实际读 `ANDROID_KEYSTORE_BASE64` + `DSH_ANDROID_KEYSTORE_PASSWORD`/`DSH_ANDROID_KEY_ALIAS`/`DSH_ANDROID_KEY_PASSWORD`，与 CONTRIBUTING 写的后三个名字不同）。每个拒绝路径要有负向测试。
11. **文档口径陷阱**：本仓库 `README.md` 顶部与兼容性表停在 **0.3.2**（上游口径，勿当现状）；`CHANGELOG.md` 本地事实从 0.3.26 起，且有 0.3.23/0.3.24 顺序颠倒、0.3.14 重复、中段陈旧 `## Unreleased`。
12. **APK 分发链路**：工作区 `~/dsh-apk-dl/` 当前 manifest 指向 **dsh-mobile-flutter** APK；父仓库 `dsh-apk-dl/` 只是服务源码。

## 相关文档

- 本目录：`README.md`/`README.en.md`、`CHANGELOG.md`、`SECURITY.md`、`CONTRIBUTING.md`、`apps/mobile/README.zh-CN.md`、`design-system/dsh-mobile/MASTER.md`、`docs/backstop-design.md`。
- 父仓库：`../PLUGINS.md`（登记 + 兼容矩阵）、`../CHANGES.md`（dsh 核心改造登记）、`../RESOURCES.md`（18443/18452、frp 隧道、`~/dsh-apk-dl/`）、`../PLUGIN-DEV.md`、`../AGENTS.md`。
