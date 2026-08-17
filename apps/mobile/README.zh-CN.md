# DeepSeek Harness Android App

[English](README.md) · [返回项目首页](../../README.md)

DeepSeek Harness 是这个轻量、社区维护的 Android WebView 薄壳的显示名称。它不打包另一份 DSH 前端，而是访问插件提供的同一个 HTTPS 地址，因此 App 与手机浏览器会获得相同的 DSH 功能，以及可以实时编辑的 `mobile.css` 外观和 `mobile.js` 功能。

当前只支持 Android。iOS 不进入构建、Release 或支持范围。

## 使用

1. 按项目首页的快速开始安装插件并运行 `dsh-mobile setup`。
2. 从 GitHub Release 安装 Android APK。
3. 在电脑 DSH 左下角的“移动端”卡片中点击“生成配对密钥”。
4. 打开 App，点击“扫描”，选择发现的 DSH，再粘贴一次性密钥并连接。证书固定只保存在 App 内，不修改 Android 系统设置。

首次配对完后，App 使用 Android Keystore 加密保存可随时撤销的长期设备 token，日常 Web 会话仍然是短期的。电脑的局域网 IP 变化后，App 会扫描默认端口，用稳定的 DSH 安装标识找回同一台电脑，换取新的短期 Web 会话，并自动更新保存的地址。发现过程不会暴露设备 token 或 Session 凭据。

自动发现会同时监听 DNS-SD/mDNS 与周期性 UDP 公告，也保留端口 `3443` 的主动 UDP 查询和私有 Wi-Fi、热点 `/24` 网段探测兜底。结果按稳定安装标识合并并更新地址。首页只显示扫描按钮和结果列表，点击一台 DSH 后才输入它的密钥。手机浏览器不走原生密钥流程，而是直接打开电脑“移动端”卡片显示的完整一次性链接。

## 为什么使用 App

- 没有浏览器地址栏和标签栏，纵向空间更完整。
- 系统返回键先处理同源 WebView 历史。
- 文件选择、同源下载、分享和清除站点数据使用受限的原生实现。
- 与手机浏览器访问同一页面，不形成第二套 UI 或协议。

手机浏览器始终是一等入口；不安装 App 也可以完整完成配对和访问。

## 安全边界

| 控制项 | Android 行为 |
| --- | --- |
| 传输 | 只接受 HTTPS origin，Manifest 禁止明文流量。 |
| TLS | CA 只在 App 内固定；仅接受它为精确主机和有效期签发的服务器证书，其余 `SslError` 全部取消。 |
| Origin | 只保存协议、规范化主机和端口；普通路径、查询和 fragment 不持久化。 |
| 导航 | 同源主页面留在 WebView；用户点击的外部 HTTPS 链接交给系统浏览器。 |
| 权限 | 文件输入使用系统文档选择器，不申请宽泛存储权限。 |
| 下载 | 只允许当前 exact origin 的前台 GET；认证控制路径永不下载。 |
| 数据 | 设备 token 由 Android Keystore 加密；Web 存储位于 App 沙箱；清除站点数据会删除设备凭据、origin、Cookie、缓存和 Web 存储。 |
| 备份 | App 备份关闭，TLS 私钥和签名密钥不得进入仓库。 |

网络安全配置不信任用户安装的 CA。插件会为所选网卡的当前地址签发新的 SAN，App 则在加密设备凭据中保存稳定 CA 固定。

## 构建

需要 Android Studio 或 Android SDK 36、JDK 17 和 Gradle 8.11.1。

```powershell
Set-Location apps/mobile/android
gradle wrapper --gradle-version 8.11.1
./gradlew.bat :app:testDebugUnitTest :app:assembleDebug
```

Debug APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。当前 Alpha 的 GitHub Release 只提供临时 debug 签名构建；正式发布必须使用仓库外保存的稳定签名密钥生成 release APK 或 AAB。

## 验收

共享 URL 策略测试覆盖 origin 规范化、配对入口、同源导航和下载路径。真机仍需验证小屏、横屏、刘海与手势区、软键盘、字体缩放、有效与无效 TLS、文件输入、下载、返回、旋转和清除数据后的重新认证。

Apache-2.0 licensed. See [LICENSE](../../LICENSE).
