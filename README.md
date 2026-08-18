<p align="center">
  <img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/assets/brand/repository-hero.png" alt="用手机使用电脑中的 DeepSeek Harness" width="100%">
</p>

<h1 align="center">DSH Mobile</h1>

<p align="center">在手机上安全、实时地使用电脑中的 DeepSeek Harness。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-mobile"><img src="https://img.shields.io/npm/v/dsh-mobile?tag=alpha&label=npm&color=CB3837" alt="npm 版本"></a>
  <a href="https://github.com/saya-ch/dsh-mobile/actions/workflows/ci.yml"><img src="https://github.com/saya-ch/dsh-mobile/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/saya-ch/dsh-mobile/releases"><img src="https://img.shields.io/badge/Android-10%2B-3DDC84?logo=android&logoColor=white" alt="Android 10+"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-0F172A" alt="Apache-2.0"></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#能做什么">能做什么</a> ·
  <a href="#在-dsh-对话中自定义">自定义</a> ·
  <a href="README.en.md">English</a>
</p>

> Alpha 版本，当前原生 App 仅支持 Android；iOS 客户端仍为未发布的本地开发实验，不进入构建与 Release。本项目为 DeepSeek Harness 社区插件。

<p align="center"><a href="https://github.com/saya-ch/dsh-mobile/releases"><strong>下载 Android App</strong></a></p>

DSH Mobile 是一个 DeepSeek Harness 插件，让手机成为电脑 DSH 的第二块屏幕：Android App 或手机浏览器通过受保护的局域网安全连接，会话、工具、消息、运行状态实时同步。不修改 DSH 源码，也不需要公网穿透。

最特别的，是它让**用对话定制移动端**成为现实：在 DSH 对话里提出修改，打开的手机页面几秒内就会刷新——把 DeepSeek Harness 的对话能力，用在自己的手机界面上。

## 快速开始

已经安装 `dsh` 命令：

```powershell
dsh plugin --profile web add dsh-mobile@alpha
dsh plugin --profile web exec dsh-mobile setup
dsh --profile web
```

直接使用 DeepSeek Harness 源码：

```powershell
corepack enable; pnpm install
pnpm dsh plugin --profile web add dsh-mobile@alpha
pnpm dsh plugin --profile web exec dsh-mobile setup
pnpm dsh --profile web
```

启动后，在 DeepSeek Harness 左下角打开“移动访问”，然后：

1. 点击“生成并复制密钥”或“复制配对链接”，面板会显示配对二维码。
2. Android App 点击“扫码配对”，把手机对准电脑屏幕上的二维码即可；也可以点击“扫描”选择电脑后粘贴密钥或配对链接。
3. 配对完成后会建立持久设备信任，以后打开 App 无需重复输入。

`setup` 会自动选择并记住当前局域网，切换 Wi-Fi、热点或 IP 后通常自动恢复；仅在自动选择失败时使用 `--address 192.168.x.x`。设置、证书、设备和自定义文件保存在 `$DSH_HOME/mobile-access/`。

## 能做什么

- **在手机上继续电脑端的工作**：同一份会话、工作区、消息和工具，实时同步。
- **用对话定制手机端**：直接在 DSH 对话里改手机页面的布局、交互和功能，几秒内刷新。
- **专属触屏布局**：会话抽屉、工具详情、设置和输入栏都按手机重新组织。
- **自动发现、无需重新配对**：切换 Wi-Fi、热点或 IP 后通常自动恢复。
- **三种配对方式任选**：扫码、配对链接、密钥。

配对设备被视为完全信任，可以操作电脑上的 DSH；建议只在可信的家庭、办公局域网或可信 VPN 中使用。

## App 与手机浏览器

| 方式        | 适合场景         | 说明                                                                    |
| ------------- | ------------------ | ------------------------------------------------------------------------- |
| Android App | 日常使用         | 自动发现；App 内保存私有证书信任，无需在浏览器手动信任证书              |
| 手机浏览器  | 临时或跨平台访问 | 打开“移动访问”卡片显示的 HTTPS 地址；首次连接需在浏览器手动信任该证书 |

Android App 只是 Kotlin WebView 薄壳，不内置另一份网页；手机浏览器访问的是同一页面。需要排查兼容性时，可在浏览器地址后追加 `?frontend=stock`，临时回到旧的桌面页面适配模式。

## 在 DSH 对话中自定义

默认文件：

```text
$DSH_HOME/mobile-access/mobile.css
$DSH_HOME/mobile-access/mobile.js
```

直接在 DeepSeek Harness 对话中提出修改即可，例如：

```text
请编辑 $DSH_HOME/mobile-access/mobile.css 和 mobile.js，
把移动端改成适合单手操作的开发控制台：增加底部快捷指令、
会话状态面板和长按语音入口。只影响窄屏，不修改 DSH 源码。
```

保存后，已打开的 App 和浏览器通常会在几秒内应用变化。`mobile.css`/`mobile.js` 负责手机端样式和交互；浏览器按 Web API 能力降级，Android App 额外提供文件选择、拍照、分享、剪贴板和通知等原生能力。

### 扩展电脑端能力

需要手机调用新的电脑能力（读文件、跑命令、访问硬件）时，用命令生成扩展模板：

```powershell
dsh plugin --profile web exec dsh-mobile extension create media-tools --name "媒体工具"
```

扩展放在 `$DSH_HOME/mobile-access/extensions/<id>/`：`host.mjs` 在电脑端以可信本地代码运行并注册 Action/Route，`mobile.js`/`mobile.css` 在手机端加载，同一扩展热切换、失败自动回退上一版。手机没有写入扩展文件的接口。发布型 DSH 插件也可调用 `ctx.mobileAccess.registerExtension(definition)` 注册扩展。

> ⚠️ `host.mjs` 拥有桌面用户的 Node.js 权限且不沙箱，请只安装和编辑自己信任的扩展。

## 工作原理

```mermaid
flowchart LR
  Phone["Android App / 手机浏览器"] -->|"HTTPS + 设备会话"| Gateway["DSH Mobile 网关"]
  Gateway -->|"回环代理"| DSH["原生 DSH Web 与 Host"]
  DSH -->|"同一工作区、会话和事件流"| Phone
```

插件包含三层：Host face 负责发现、配对、HTTPS、回环代理和扩展注册表；Client face 提供独立的移动布局与扩展 SDK；Android App 提供受限的原生 Bridge。DeepSeek Harness 的源码和 3080 桌面页面都不会被修改，安装和卸载完全通过插件机制完成。

## 安全

- 仅在可信家庭、办公局域网或可信 VPN 中使用，不要转发到公网。
- 配对设备拥有控制电脑端 DeepSeek Harness 的能力，应视为完全可信设备；丢失手机后应在电脑端撤销设备。
- 移动网关开启时才监听局域网；关闭后 DeepSeek Harness 仍正常在电脑本机运行。

完整说明见 [SECURITY.md](SECURITY.md)。

## 兼容性

| DSH Mobile       | 已验证的 DeepSeek Harness                |
| ------------------ | ------------------------------------------ |
| `0.1.0-alpha.32` | `0.1.0-rc.5`、`0.1.0-rc.6`、`0.1.0-rc.7` |

插件启动时会检查 DSH Host 版本和移动布局所需的前端依赖，遇到未经验证的版本会直接报错而不是带病启动；CI 也会持续跟踪 DSH 主分支的布局契约。升级 DSH 后如遇兼容提示，请先升级 DSH Mobile。

## 卸载

```powershell
dsh plugin --profile web remove dsh-mobile
```

同时清除插件数据：

```powershell
dsh plugin --profile web exec dsh-mobile purge --yes
dsh plugin --profile web remove dsh-mobile
```

源码模式把上述 `dsh` 换成 `pnpm dsh`。

## 开发

```powershell
npm ci
npm run verify
```

Android 构建见 [App 文档](apps/mobile/README.zh-CN.md)。

Apache-2.0，详见 [LICENSE](LICENSE)。
