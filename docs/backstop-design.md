# dsh-mobile「后盾」设计（Backstop Design）

> 状态：设计中（P1 未开工）
> 定位升级：App 不只是 dsh 的 WebView 容器，而是拥有**原生功能与数据层**的独立应用，
> 作为 dsh 的**后盾**——dsh 正常时监控与增强，dsh 挂掉时接管、自救、拉起。
> 本文档为 dsh-mobile fork 的本地改造设计，实施登记见父仓库 `CHANGES.md`。

## 1. 愿景与设计原则

- **后盾（Backstop）**：App 原生层与 dsh 侧 supervisor/intake 直连，链路（frp 隧道 → supervisor）
  独立于 dsh 进程，因此 **dsh 崩溃/启动失败时后盾依然可用**。
- **原生优先**：监控、自救、日志、控制都是原生功能（Kotlin），不依赖 WebView 页面；
  WebView 仍是连接正常时的主体验（dsh 网页容器）。
- **只读默认、写操作显式**：健康/日志/上报只读；自救/重启/回退都是显式按钮 + 二次确认。
- **省电省流量**：后台监控用 WorkManager 节流（前台快、后台慢、充电可密），不做 LLM 轮询。
- **安全渐进**：读端点维持现状（公网可达），控制端点必须鉴权；P3 全端点鉴权 + 证书指纹。

## 2. 架构分层

```
┌─ dsh-mobile App（Android）────────────────────────────────┐
│ 原生层（Kotlin，纯代码 UI）                                │
│  ├─ BackstopConsole（新页面，Activity 内）                 │
│  │    状态卡 / 上报列表 / 日志查看 / 操作区 / 自动刷新      │
│  ├─ BackstopService（新，核心单例/绑定服务）               │
│  │    HealthMonitor   轮询 GET /health（前台 10-30s）      │
│  │    RescueClient    现有 SelfRescueClient 扩展          │
│  │    LogFetcher      GET /log /reports /analysis         │
│  │    ControlClient   POST /restart（Bearer token）       │
│  │    Notifier        崩溃 / 恢复 / 自救结果 通知          │
│  ├─ DataLayer（新，Room/SQLite）                          │
│  │    健康快照历史、上报列表缓存、日志尾部缓存             │
│  ├─ 后台任务（新，WorkManager）                           │
│  │    周期健康检查（前台 10s / 后台 15min / 充电 2min）    │
│  └─ 现有：连接管理 / 配对 / WebView 容器 / NativeBridge    │
└───────────────────────────────────────────────────────────┘
        │ HTTPS（frp 隧道 dsh-rescue-intake，公网 feiyueve.com:18443/rescue-intake/*）
        ▼
┌─ dsh 侧 ──────────────────────────────────────────────────┐
│ supervisor intake（127.0.0.1:18445，supervisor 内嵌）      │
│  GET  /health /reports /analysis /log   （读，公开）       │
│  POST /rescue                            （已有，互斥 409）│
│  POST /restart                           （新增，鉴权）    │
│  POST /rollback                          （P3，鉴权）      │
└───────────────────────────────────────────────────────────┘
```

## 3. 模块设计

### 3.1 BackstopService（原生核心）

- **端点解析**：与 SelfRescueClient 一致——REMOTE 模式用 `https://feiyueve.com:18443/rescue-intake`，
  LAN 模式可配置本地 intake（`http://<网关>:18445` 仅限同一局域网可信网络，P2）。
- **HealthMonitor**：`GET /health` → `{ok, pid, childAlive, rescueActive}`；
  状态变化（childAlive 翻转、lastCrashAt 变化）触发回调 → UI 更新 + Notifier。
- **LogFetcher**：`GET /log`（尾部，bytes 参数分页）、`GET /reports`/`GET /analysis`（JSON 行列表）。
- **ControlClient**：`POST /restart`（等价 supervisor 的 SIGHUP / touch restart.trigger），
  携带 `Authorization: Bearer <token>`；409/401 错误映射为可读文案。
- **Notifier**：崩溃通知（"dsh 已停止，可一键自救"）、恢复通知、自救结果通知；通知点击直达控制台。

### 3.2 BackstopConsole（原生 UI）

入口：**连接中心**新增「后盾控制台」按钮（不依赖连接模式与连接状态，随时可达）。
页面结构（沿用现有纯代码 UI 风格：卡片 + ScrollView）：

| 区块 | 内容 |
|---|---|
| 状态卡 | web 进程（运行/停止/自救中）、摄入服务（ok）、最后崩溃时间、最近恢复时间 |
| 上报列表 | 最近 N 条前端/崩溃上报（时间、来源、摘要），点击展开详情 |
| 日志查看 | intake/服务日志尾部，自动滚动，可暂停 |
| 操作区 | 一键自救（二次确认）、重启 dsh（二次确认）、（P3：回退到 last good） |
| 工具条 | 刷新、自动刷新开关（前台 10s） |

### 3.3 DataLayer 与后台任务

- Room 表：`health_snapshot`（时间、childAlive、rescueActive、崩溃时间戳）、`report_cache`（原始 JSON 行）、`log_tail`。
- WorkManager：前台可见 → 10-30s 轮询；退后台 → 15min；充电时 2min；
  仅当已配置网关且网络可用时运行（省流量）；崩溃时立即通知并短暂加密轮询（30s×3）确认。

## 4. dsh 侧配套（supervisor intake 扩展）

| 端点 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/health` `/reports` `/analysis` `/log` | GET | 无（现状） | P3 改为可选用 token |
| `/report` `/rescue` | POST | 无（现状） | /rescue 已有互斥 |
| `/restart` | POST | **Bearer**（新增） | 等价 `touch restart.trigger`；409 当自救进行中 |
| `/rollback` | POST | **Bearer**（P3） | 等价 `dsh-web-supervisor rollback` |

- **Token 机制**：supervisor 首次启动生成随机 token 写 `.service/access.token`（0600，不入 git）；
  App 端「后盾设置」扫码/粘贴 token（复用现有 QrDecoder）。P3 可改为配对流程自动下发。
- **安全**：控制端点无 token 一律 401；token 泄露可手动轮换（删除文件重启 supervisor 重新生成）；
  自救/重启等写操作记录到 intake 日志（audit）。

## 5. 分期实施

| 阶段 | 内容 | 交付 |
|---|---|---|
| **P1** | 后盾控制台（状态卡/上报列表/日志/自救/重启）+ BackstopService 只读与自救 + 连接中心入口 | 新 APK，控制台可用 |
| **P2** | 通知 + WorkManager 后台监控 + Room 历史 + 自动刷新 | 崩溃即知，历史可查 |
| **P3** | /restart 鉴权落地 + /rollback + 全端点 token + TLS 证书指纹（复用 PinnedTls） | 公网安全加固 |

P1 依赖：supervisor intake 新增 `POST /restart`（改 `/usr/local/sbin/dsh-web-supervisor`，工作副本流程）。
P1 范围刻意不含后端轮询/通知（先做交互闭环，用户确认后再加后台行为）。

## 6. 与 upstream 的关系

- dsh-mobile 全部新增代码：本地改造（分支 `local/backstop`，父仓库 `CHANGES.md` 登记，按 PLUGIN-DEV.md 流程）。
- supervisor intake 扩展：本地运维脚本（`scratch-supervisor/`），非仓库内。
- 对 dsh 核心（deepseek-harness）**零改动**。
