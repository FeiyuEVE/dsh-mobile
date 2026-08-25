import { createElement } from 'react'
import { installNativeMobileSurface, NATIVE_MOBILE_STYLES } from './native-mobile.js'

interface ClientContext {
  effect(effect: () => void | (() => void), label?: string): void
  get(name: 'connection'): MobileConnectionHandle
  slots: {
    inject(key: string, callback: () => (() => void)): () => void
    register(options: { name: string; id: string }, component: (props: { wide: boolean }) => unknown): () => void
  }
}

interface MobileConnectionHandle {
  isLoopback: boolean
}

interface MobileExtensionContext {
  readonly document: Document
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly root: HTMLElement
  readonly window: Window
}

type MobileExtensionMount = (context: MobileExtensionContext) => void | (() => void)
type MobileSurfacePlacement = 'page' | 'sidebar-action' | 'header-action' | 'composer-dock' | 'settings-section' | 'overlay'
interface MobileSurface {
  readonly id: string
  readonly placement: MobileSurfacePlacement
  readonly label: string
  mount(container: HTMLElement): void | (() => void)
}
interface MobileClientApi {
  readonly host: {
    invoke(action: string, input: unknown): Promise<unknown>
    fetch(path: string, init?: RequestInit): Promise<Response>
  }
  readonly ui: {
    registerSurface(surface: MobileSurface): () => void
    open(surfaceId: string): void
    close(surfaceId: string): void
    toast(message: string): void
  }
  readonly native: {
    capabilities(): Promise<readonly string[]>
    invoke(action: string, input?: unknown): Promise<unknown>
  }
  readonly signal: AbortSignal
  readonly document: Document
  readonly window: Window
}
interface MobileClientDefinition {
  readonly apiVersion: 1
  readonly id: string
  activate(api: MobileClientApi): void | (() => void) | Promise<void | (() => void)>
}

declare global {
  interface Window {
    dshMobile?: {
      register(mount: MobileExtensionMount): void
      define(definition: MobileClientDefinition): void
    }
    __DSH_MOBILE_FRONTEND__?: 'dedicated'
    __DSH_MOBILE_NATIVE__?: {
      capabilities(): Promise<readonly string[]> | readonly string[]
      invoke(action: string, input?: unknown): Promise<unknown>
    }
  }
}

const queuedDefinitions: MobileClientDefinition[] = []
let queuedLegacyMount: MobileExtensionMount | undefined
if (typeof window !== 'undefined' && window.dshMobile === undefined) {
  window.dshMobile = {
    register: mount => { queuedLegacyMount = mount },
    define: definition => { queuedDefinitions.push(definition) },
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

/**
 * Match DSH's client-side privilege hint to the authenticated mobile gateway.
 * The gateway authenticates the paired device and forwards allowed requests to
 * DSH's loopback listener, so settings RPCs receive the same Host-side checks
 * as the desktop page even though the phone's visible URL is a LAN address.
 */
export function trustAuthenticatedGatewayConnection(connection: MobileConnectionHandle): () => void {
  const previous = connection.isLoopback
  connection.isLoopback = true
  return () => { connection.isLoopback = previous }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  return node
}

async function requestJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } })
  const body = await response.json() as Record<string, unknown>
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${String(response.status)}`)
  return body
}

function officialFunnelSetupUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return ''
  let url: URL
  try { url = new URL(value) } catch { return '' }
  const normalized = url.toString().replace(/\/$/u, '')
  if (normalized === 'https://tailscale.com/s/no-funnel' || normalized === 'https://tailscale.com/s/https') return normalized
  if (url.protocol !== 'https:' || url.hostname !== 'login.tailscale.com' || url.port !== ''
    || url.username !== '' || url.password !== '') return ''
  return url.toString()
}

function installControl(): { remove: () => void; toggle: () => void } {
  const root = element('div', 'dsh-mobile-control')
  const panel = element('section', 'dsh-mobile-control__panel'); panel.hidden = true
  panel.setAttribute('aria-label', '移动访问')
  const header = element('header', 'dsh-mobile-control__header')
  const title = element('h2'); title.textContent = '移动访问'
  const close = element('button', 'dsh-mobile-control__close'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '收起移动访问')
  const appDownload = element('a', 'dsh-mobile-control__app-download'); appDownload.href = 'https://github.com/saya-ch/dsh-mobile/releases/latest'; appDownload.target = '_blank'; appDownload.rel = 'noopener noreferrer'; appDownload.textContent = '下载 Android App'; appDownload.setAttribute('aria-label', '前往 GitHub Releases 下载最新版 Android App')
  const switcher = element('div', 'dsh-mobile-control__switcher')
  const lanTab = element('button', 'dsh-mobile-control__tab is-active'); lanTab.type = 'button'; lanTab.textContent = '局域网'
  const remoteTab = element('button', 'dsh-mobile-control__tab'); remoteTab.type = 'button'; remoteTab.textContent = '远程'
  lanTab.setAttribute('aria-pressed', 'true'); remoteTab.setAttribute('aria-pressed', 'false'); switcher.append(lanTab, remoteTab)
  const lanView = element('div', 'dsh-mobile-control__view')
  const access = element('div', 'dsh-mobile-control__access'); access.hidden = true
  const accessLabel = element('span', 'dsh-mobile-control__access-label'); accessLabel.textContent = '浏览器访问'
  const accessLink = element('a', 'dsh-mobile-control__access-link'); accessLink.target = '_blank'; accessLink.rel = 'noreferrer'
  access.append(accessLabel, accessLink)
  const qrBox = element('div', 'dsh-mobile-control__qr'); qrBox.hidden = true
  const status = element('p', 'dsh-mobile-control__status'); status.textContent = '正在读取状态…'
  const extensionStatus = element('p', 'dsh-mobile-control__extensions'); extensionStatus.hidden = true
  const actions = element('div', 'dsh-mobile-control__actions')
  const toggle = element('button', 'dsh-mobile-control__secondary'); toggle.type = 'button'
  const pair = element('button', 'dsh-mobile-control__primary'); pair.type = 'button'; pair.textContent = '生成并复制密钥'
  const linkPair = element('button', 'dsh-mobile-control__secondary'); linkPair.type = 'button'; linkPair.textContent = '复制配对链接'
  const manageRow = element('div', 'dsh-mobile-control__manage-row')
  const manageDevices = element('button', 'dsh-mobile-control__manage'); manageDevices.type = 'button'; manageDevices.textContent = '管理配对设备'
  const resetAll = element('button', 'dsh-mobile-control__manage'); resetAll.type = 'button'; resetAll.textContent = '清除所有设备'
  manageRow.append(manageDevices, resetAll)
  const devicePanel = element('div', 'dsh-mobile-control__devices'); devicePanel.hidden = true
  const remoteView = element('div', 'dsh-mobile-control__view is-remote'); remoteView.hidden = true
  const remoteIntro = element('p', 'dsh-mobile-control__intro'); remoteIntro.textContent = '选择更适合你的远程通道。切换或关闭远程访问不会影响局域网。'
  const providerSection = element('section', 'dsh-mobile-control__provider-section')
  const providerHeading = element('h3', 'dsh-mobile-control__section-title'); providerHeading.textContent = '选择连接方式'
  const providerInfo = element('div', 'dsh-mobile-control__provider-info')
  const providerInfoButton = element('button', 'dsh-mobile-control__provider-info-button'); providerInfoButton.type = 'button'; providerInfoButton.setAttribute('aria-label', '查看远程连接安全与网络说明'); providerInfoButton.setAttribute('aria-expanded', 'false'); providerInfoButton.setAttribute('aria-controls', 'dsh-mobile-provider-info'); providerInfoButton.setAttribute('aria-describedby', 'dsh-mobile-provider-info')
  const providerInfoGlyph = element('span', 'dsh-mobile-control__provider-info-glyph'); providerInfoGlyph.textContent = 'i'; providerInfoGlyph.setAttribute('aria-hidden', 'true')
  const providerInfoPopover = element('div', 'dsh-mobile-control__provider-info-popover'); providerInfoPopover.id = 'dsh-mobile-provider-info'; providerInfoPopover.setAttribute('role', 'tooltip'); providerInfoPopover.hidden = true
  const providerInfoTitle = element('strong'); providerInfoTitle.textContent = '你始终可以放心'
  const providerInfoText = element('span'); providerInfoText.textContent = '只有已配对设备能进入 DSH。cpolar 按需安装并可彻底清理；Tailscale 在中国大陆网络下可能连接缓慢、中断或无法使用，国内网络建议优先尝试 cpolar。'
  providerInfoButton.append(providerInfoGlyph); providerInfoPopover.append(providerInfoTitle, providerInfoText); providerInfo.append(providerInfoButton, providerInfoPopover)
  const providerChoices = element('div', 'dsh-mobile-control__provider-choices'); providerChoices.setAttribute('role', 'radiogroup'); providerChoices.setAttribute('aria-label', '远程连接方式')
  const tailscaleChoice = element('button', 'dsh-mobile-control__provider'); tailscaleChoice.type = 'button'; tailscaleChoice.setAttribute('role', 'radio'); tailscaleChoice.setAttribute('aria-checked', 'true')
  const tailscaleChoiceTop = element('span', 'dsh-mobile-control__provider-top')
  const tailscaleChoiceName = element('strong'); tailscaleChoiceName.textContent = 'Tailscale Funnel'
  const tailscaleChoiceBadge = element('span', 'dsh-mobile-control__provider-badge'); tailscaleChoiceBadge.textContent = '内置'
  const tailscaleChoiceDescription = element('span', 'dsh-mobile-control__provider-description'); tailscaleChoiceDescription.textContent = '覆盖更广；中国大陆网络可能不稳定，首次需登录并允许 Funnel。'
  tailscaleChoiceTop.append(tailscaleChoiceName, tailscaleChoiceBadge); tailscaleChoice.append(tailscaleChoiceTop, tailscaleChoiceDescription)
  const cpolarChoice = element('button', 'dsh-mobile-control__provider'); cpolarChoice.type = 'button'; cpolarChoice.setAttribute('role', 'radio'); cpolarChoice.setAttribute('aria-checked', 'false')
  const cpolarChoiceTop = element('span', 'dsh-mobile-control__provider-top')
  const cpolarChoiceName = element('strong'); cpolarChoiceName.textContent = 'cpolar'
  const cpolarChoiceBadge = element('span', 'dsh-mobile-control__provider-badge is-cpolar'); cpolarChoiceBadge.textContent = '国内网络优先'
  const cpolarChoiceDescription = element('span', 'dsh-mobile-control__provider-description'); cpolarChoiceDescription.textContent = '按需安装官方组件，适合国内网络环境。'
  cpolarChoiceTop.append(cpolarChoiceName, cpolarChoiceBadge); cpolarChoice.append(cpolarChoiceTop, cpolarChoiceDescription)
  providerChoices.append(tailscaleChoice, cpolarChoice); providerSection.append(providerHeading, providerInfo, providerChoices)
  const cpolarSetup = element('section', 'dsh-mobile-control__cpolar-setup'); cpolarSetup.hidden = true
  const cpolarSetupTitle = element('h3', 'dsh-mobile-control__section-title'); cpolarSetupTitle.textContent = '准备 cpolar'
  const cpolarComponentStatus = element('p', 'dsh-mobile-control__component-status'); cpolarComponentStatus.textContent = '正在检查组件…'
  const cpolarInstall = element('button', 'dsh-mobile-control__primary'); cpolarInstall.type = 'button'; cpolarInstall.textContent = '安装官方组件'
  const cpolarAccount = element('div', 'dsh-mobile-control__cpolar-account'); cpolarAccount.hidden = true
  const cpolarAccountText = element('p', 'dsh-mobile-control__component-note'); cpolarAccountText.textContent = '登录 cpolar 官网后复制 Authtoken。令牌只保存在本机插件私有目录，不会显示在页面或日志中。'
  const cpolarAccountLinks = element('div', 'dsh-mobile-control__link-row')
  const cpolarSignup = element('a', 'dsh-mobile-control__text-link'); cpolarSignup.href = 'https://dashboard.cpolar.com/signup'; cpolarSignup.target = '_blank'; cpolarSignup.rel = 'noopener noreferrer'; cpolarSignup.textContent = '注册 cpolar'
  const cpolarDashboard = element('a', 'dsh-mobile-control__text-link'); cpolarDashboard.href = 'https://dashboard.cpolar.com/auth'; cpolarDashboard.target = '_blank'; cpolarDashboard.rel = 'noopener noreferrer'; cpolarDashboard.textContent = '打开控制台获取令牌'
  cpolarAccountLinks.append(cpolarSignup, cpolarDashboard)
  const cpolarTokenLabel = element('label', 'dsh-mobile-control__token-label'); cpolarTokenLabel.textContent = 'Authtoken'
  const cpolarToken = element('input', 'dsh-mobile-control__token'); cpolarToken.type = 'password'; cpolarToken.autocomplete = 'off'; cpolarToken.spellcheck = false; cpolarToken.placeholder = '粘贴 cpolar Authtoken'; cpolarTokenLabel.append(cpolarToken)
  const cpolarConfigure = element('button', 'dsh-mobile-control__primary dsh-mobile-control__cpolar-connect'); cpolarConfigure.type = 'button'; cpolarConfigure.textContent = '保存并连接'
  cpolarAccount.append(cpolarAccountText, cpolarAccountLinks, cpolarTokenLabel, cpolarConfigure)
  const cpolarDetails = element('details', 'dsh-mobile-control__details')
  const cpolarDetailsSummary = element('summary'); cpolarDetailsSummary.textContent = '组件来源与清理说明'
  const cpolarDetailsBody = element('div', 'dsh-mobile-control__details-body')
  const cpolarDetailsText = element('p'); cpolarDetailsText.textContent = '仅在你点击安装后从 cpolar 官网下载并校验固定版本。不会写入系统服务、开机启动、注册表或 PATH。'
  const cpolarStorage = element('code', 'dsh-mobile-control__storage'); cpolarStorage.textContent = '插件私有目录'
  const cpolarOfficial = element('a', 'dsh-mobile-control__text-link'); cpolarOfficial.href = 'https://www.cpolar.com/download'; cpolarOfficial.target = '_blank'; cpolarOfficial.rel = 'noopener noreferrer'; cpolarOfficial.textContent = '官方下载安装页'
  const cpolarTerms = element('a', 'dsh-mobile-control__text-link'); cpolarTerms.href = 'https://www.cpolar.com/tos'; cpolarTerms.target = '_blank'; cpolarTerms.rel = 'noopener noreferrer'; cpolarTerms.textContent = '服务条款'
  const cpolarPurge = element('button', 'dsh-mobile-control__danger'); cpolarPurge.type = 'button'; cpolarPurge.textContent = '彻底移除 cpolar 组件与配置'
  cpolarDetailsBody.append(cpolarDetailsText, cpolarStorage, cpolarOfficial, cpolarTerms, cpolarPurge); cpolarDetails.append(cpolarDetailsSummary, cpolarDetailsBody)
  cpolarSetup.append(cpolarSetupTitle, cpolarComponentStatus, cpolarInstall, cpolarAccount, cpolarDetails)
  const tailscaleInfo = element('details', 'dsh-mobile-control__details')
  const tailscaleInfoSummary = element('summary'); tailscaleInfoSummary.textContent = 'Tailscale 使用说明'
  const tailscaleInfoBody = element('div', 'dsh-mobile-control__details-body')
  const tailscaleInfoText = element('p'); tailscaleInfoText.textContent = '运行组件已随插件提供。首次连接会打开 Tailscale 官方登录和 Funnel 授权页；插件不会接触你的账号密码。'
  tailscaleInfoBody.append(tailscaleInfoText); tailscaleInfo.append(tailscaleInfoSummary, tailscaleInfoBody)
  const remoteAccess = element('div', 'dsh-mobile-control__access'); remoteAccess.hidden = true
  const remoteAccessLabel = element('span', 'dsh-mobile-control__access-label'); remoteAccessLabel.textContent = '远程地址'
  const remoteAccessLink = element('a', 'dsh-mobile-control__access-link'); remoteAccessLink.target = '_blank'; remoteAccessLink.rel = 'noreferrer'; remoteAccess.append(remoteAccessLabel, remoteAccessLink)
  const remoteQr = element('div', 'dsh-mobile-control__qr'); remoteQr.hidden = true
  const remoteStatus = element('p', 'dsh-mobile-control__status'); remoteStatus.textContent = '正在读取远程状态…'; remoteStatus.setAttribute('aria-live', 'polite')
  const remoteGuide = element('section', 'dsh-mobile-control__guide'); remoteGuide.hidden = true; remoteGuide.setAttribute('aria-label', 'Tailscale Funnel 启用步骤')
  const remoteGuideTitle = element('h3', 'dsh-mobile-control__guide-title'); remoteGuideTitle.textContent = '远程访问设置 · 第 2 步'
  const remoteGuideSummary = element('p', 'dsh-mobile-control__guide-summary'); remoteGuideSummary.textContent = 'Tailscale 登录已完成。还需为这台电脑允许 Funnel，官方页面会同时启用 HTTPS。'
  const remoteGuideSteps = element('ol', 'dsh-mobile-control__guide-steps')
  for (const text of ['打开当前节点的 Tailscale 官方授权页。', '确认启用 Funnel；无需再次登录 DSH。', '返回 DSH，插件会自动检查并建立连接。']) {
    const item = element('li'); item.textContent = text; remoteGuideSteps.append(item)
  }
  const remoteGuideNote = element('p', 'dsh-mobile-control__guide-note'); remoteGuideNote.textContent = '需要使用 Owner、Admin 或 Network admin 账号。'
  const remoteGuideActions = element('div', 'dsh-mobile-control__guide-actions')
  const remoteSetup = element('button', 'dsh-mobile-control__primary'); remoteSetup.type = 'button'; remoteSetup.textContent = '继续完成 Funnel 授权'
  const remoteSetupRetry = element('button', 'dsh-mobile-control__secondary'); remoteSetupRetry.type = 'button'; remoteSetupRetry.textContent = '已完成，立即重试'
  remoteGuideActions.append(remoteSetup, remoteSetupRetry); remoteGuide.append(remoteGuideTitle, remoteGuideSummary, remoteGuideSteps, remoteGuideNote, remoteGuideActions)
  const remoteActions = element('div', 'dsh-mobile-control__actions')
  const remoteToggle = element('button', 'dsh-mobile-control__primary'); remoteToggle.type = 'button'; remoteToggle.textContent = '启用远程访问'
  const remoteLogin = element('button', 'dsh-mobile-control__primary'); remoteLogin.type = 'button'; remoteLogin.textContent = '继续登录'; remoteLogin.hidden = true
  const remoteReconnect = element('button', 'dsh-mobile-control__secondary'); remoteReconnect.type = 'button'; remoteReconnect.textContent = '重新连接'; remoteReconnect.hidden = true
  const remotePair = element('button', 'dsh-mobile-control__secondary'); remotePair.type = 'button'; remotePair.textContent = '生成远程配对二维码'; remotePair.disabled = true
  remoteActions.append(remoteToggle, remoteLogin, remoteReconnect, remotePair)
  const remoteManageRow = element('div', 'dsh-mobile-control__manage-row')
  const remoteDevices = element('button', 'dsh-mobile-control__manage'); remoteDevices.type = 'button'; remoteDevices.textContent = '管理远程设备'; remoteDevices.disabled = true
  const remoteReset = element('button', 'dsh-mobile-control__manage'); remoteReset.type = 'button'; remoteReset.textContent = '退出并清除远程登录'
  remoteManageRow.append(remoteDevices, remoteReset)
  const remoteDevicePanel = element('div', 'dsh-mobile-control__devices'); remoteDevicePanel.hidden = true
  header.append(title, close); actions.append(toggle, pair, linkPair)
  lanView.append(access, qrBox, status, extensionStatus, actions, manageRow, devicePanel)
  remoteView.append(remoteIntro, providerSection, cpolarSetup, tailscaleInfo, remoteAccess, remoteQr, remoteStatus, remoteGuide, remoteActions, remoteManageRow, remoteDevicePanel)
  panel.append(header, appDownload, switcher, lanView, remoteView); root.append(panel); document.body.append(root)
  let running = false
  let origin = ''
  let remoteRunning = false
  let remoteReady = false
  let remoteProvider: 'tailscale' | 'cpolar' = 'tailscale'
  let remoteLoginUrl = ''
  let remoteSetupUrl = ''
  let remoteSetupPending = false
  let remoteSetupOpenedAt = 0
  let remoteReconnectBusy = false
  let remoteProviderBusy = false
  let cpolarInstalled = false
  let cpolarConfigured = false
  let providerInfoPinned = false
  let providerInfoHovered = false
  const syncProviderInfo = (): void => {
    const open = providerInfoPinned || providerInfoHovered || providerInfo.contains(document.activeElement)
    providerInfoPopover.hidden = !open
    providerInfoButton.setAttribute('aria-expanded', String(open))
  }
  providerInfo.addEventListener('pointerenter', () => { providerInfoHovered = true; syncProviderInfo() })
  providerInfo.addEventListener('pointerleave', () => { providerInfoHovered = false; syncProviderInfo() })
  providerInfo.addEventListener('focusin', syncProviderInfo)
  providerInfo.addEventListener('focusout', () => { window.setTimeout(syncProviderInfo, 0) })
  providerInfoButton.addEventListener('click', () => { providerInfoPinned = !providerInfoPinned; syncProviderInfo() })
  providerInfoButton.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    providerInfoPinned = false
    providerInfoHovered = false
    providerInfoPopover.hidden = true
    providerInfoButton.setAttribute('aria-expanded', 'false')
  })
  const selectView = (remote: boolean): void => {
    lanView.hidden = remote
    remoteView.hidden = !remote
    lanTab.classList.toggle('is-active', !remote)
    remoteTab.classList.toggle('is-active', remote)
    lanTab.setAttribute('aria-pressed', String(!remote))
    remoteTab.setAttribute('aria-pressed', String(remote))
    title.textContent = remote ? '远程访问' : '局域网访问'
  }
  lanTab.addEventListener('click', () => { selectView(false) })
  remoteTab.addEventListener('click', () => { selectView(true); loadRemote() })
  const setOpen = (open: boolean): void => {
    panel.hidden = !open
    for (const trigger of document.querySelectorAll('.dsh-mobile-control__trigger')) trigger.setAttribute('aria-expanded', String(open))
  }
  const render = (data: Record<string, unknown>): void => {
    running = data.running === true
    origin = running && typeof data.origin === 'string' ? data.origin : ''
    access.hidden = origin === ''
    accessLink.href = origin
    accessLink.textContent = origin
    accessLink.title = origin
    status.classList.toggle('is-running', running)
    status.textContent = running ? '局域网访问已开启。' : '局域网访问已关闭。'
    const extensionData = data.extensions
    if (extensionData !== null && typeof extensionData === 'object') {
      const loaded = typeof (extensionData as { loaded?: unknown }).loaded === 'number' ? (extensionData as { loaded: number }).loaded : 0
      const failed = typeof (extensionData as { failed?: unknown }).failed === 'number' ? (extensionData as { failed: number }).failed : 0
      extensionStatus.hidden = false
      extensionStatus.textContent = failed === 0 ? `扩展：${String(loaded)} 个已加载` : `扩展：${String(loaded)} 个已加载，${String(failed)} 个加载失败`
    } else extensionStatus.hidden = true
    if (!running) qrBox.hidden = true
    toggle.textContent = running ? '关闭局域网访问' : '开启局域网访问'
    pair.disabled = !running
    linkPair.disabled = !running
    manageDevices.disabled = !running
    resetAll.disabled = !running
  }
  const showQr = (svg: string, target: HTMLDivElement = qrBox): void => {
    target.replaceChildren()
    if (svg === '') { target.hidden = true; return }
    const image = element('img')
    image.alt = '配对二维码'
    image.width = 176
    image.height = 176
    image.src = `data:image/svg+xml;base64,${btoa(svg)}`
    target.hidden = false
    target.append(image)
  }
  const openPairing = (target: 'key' | 'link'): void => {
    void requestJson('/api/mobile-access/lan/pairing/open', { method: 'POST', body: '{}' }).then(async data => {
      const value = target === 'key'
        ? (typeof data.appKey === 'string' ? data.appKey : '')
        : (typeof data.pairUrl === 'string' ? data.pairUrl : '')
      showQr(typeof data.qrSvg === 'string' ? data.qrSvg : '')
      if (value === '') { status.textContent = '无法生成配对密钥。'; return }
      try {
        await navigator.clipboard.writeText(value)
        status.textContent = target === 'key'
          ? '配对密钥已复制，请粘贴到 Android App。'
          : '配对链接已复制，发给手机后 App 粘贴或浏览器打开即可配对。'
      } catch {
        status.textContent = `请复制${target === 'key' ? '配对密钥' : '配对链接'}：${value}`
        status.classList.add('is-key')
      }
    }, error => { status.textContent = String(error) }).finally(() => {
      pair.disabled = !running
      linkPair.disabled = !running
    })
  }
  toggle.addEventListener('click', () => { toggle.disabled = true; void requestJson('/api/mobile-access/lan/control', { method: 'POST', body: JSON.stringify({ running: !running }) }).then(render, error => { status.textContent = String(error) }).finally(() => { toggle.disabled = false }) })
  const formatTime = (ms: unknown): string => typeof ms === 'number' ? new Date(ms).toLocaleString() : ''
  const renderDevices = (data: Record<string, unknown>): void => {
    const devices = Array.isArray(data.devices) ? data.devices as Record<string, unknown>[] : []
    devicePanel.replaceChildren()
    if (devices.length === 0) {
      const empty = element('p', 'dsh-mobile-control__device-empty'); empty.textContent = '暂无配对设备。'
      devicePanel.append(empty)
      return
    }
    for (const device of devices) {
      const row = element('div', 'dsh-mobile-control__device')
      const label = element('span', 'dsh-mobile-control__device-label')
      label.textContent = typeof device.label === 'string' ? device.label : '设备'
      const meta = element('span', 'dsh-mobile-control__device-meta'); meta.textContent = `到期 ${formatTime(device.expiresAt)}`
      const revoke = element('button', 'dsh-mobile-control__device-revoke'); revoke.type = 'button'; revoke.textContent = '撤销'
      const id = typeof device.id === 'string' ? device.id : ''
      revoke.addEventListener('click', () => {
        void requestJson('/api/mobile-access/lan/devices/revoke', { method: 'POST', body: JSON.stringify({ deviceId: id }) })
          .then(loadDevices, error => { status.textContent = String(error) })
      })
      row.append(label, meta, revoke)
      devicePanel.append(row)
    }
  }
  const loadDevices = (): void => {
    void requestJson('/api/mobile-access/lan/devices').then(renderDevices, error => { status.textContent = String(error) })
  }
  manageDevices.addEventListener('click', () => {
    const show = devicePanel.hidden
    devicePanel.hidden = !show
    if (show) loadDevices()
  })
  resetAll.addEventListener('click', () => {
    if (!window.confirm('确定要移除所有配对设备吗？此操作会立即终止已连接设备。')) return
    void requestJson('/api/mobile-access/lan/devices/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      .then(loadDevices, error => { status.textContent = String(error) })
  })
  const renderRemote = (data: Record<string, unknown>): void => {
    remoteRunning = data.running === true
    remoteProvider = data.provider === 'cpolar' ? 'cpolar' : 'tailscale'
    const cpolar = remoteProvider === 'cpolar'
    tailscaleChoice.classList.toggle('is-selected', !cpolar)
    cpolarChoice.classList.toggle('is-selected', cpolar)
    tailscaleChoice.setAttribute('aria-checked', String(!cpolar))
    cpolarChoice.setAttribute('aria-checked', String(cpolar))
    tailscaleChoice.disabled = remoteProviderBusy
    cpolarChoice.disabled = remoteProviderBusy
    cpolarSetup.hidden = !cpolar
    tailscaleInfo.hidden = cpolar
    remoteReset.textContent = cpolar ? '关闭并清除远程设备' : '退出并清除远程登录'
    const providers = data.providers !== null && typeof data.providers === 'object' ? data.providers as Record<string, unknown> : {}
    const cpolarProvider = providers.cpolar !== null && typeof providers.cpolar === 'object' ? providers.cpolar as Record<string, unknown> : {}
    const component = cpolarProvider.component !== null && typeof cpolarProvider.component === 'object'
      ? cpolarProvider.component as Record<string, unknown>
      : {}
    cpolarInstalled = component.installed === true
    cpolarConfigured = component.configured === true
    cpolarChoiceBadge.textContent = cpolarConfigured ? '已就绪' : cpolarInstalled ? '已安装' : '国内网络优先'
    const cpolarSupported = component.supported !== false
    const componentVersion = typeof component.version === 'string' ? component.version : ''
    const componentDownloadBytes = typeof component.downloadBytes === 'number' ? component.downloadBytes : 0
    const componentStorage = typeof component.storagePath === 'string' ? component.storagePath : 'DSH Mobile 插件私有目录'
    cpolarStorage.textContent = componentStorage
    cpolarStorage.title = componentStorage
    cpolarInstall.hidden = cpolarInstalled || !cpolarSupported
    cpolarInstall.textContent = componentDownloadBytes > 0
      ? `安装官方组件 · ${(componentDownloadBytes / 1024 / 1024).toFixed(1)} MB`
      : '安装官方组件'
    cpolarInstall.disabled = remoteProviderBusy
    cpolarAccount.hidden = !cpolarInstalled || cpolarConfigured
    cpolarConfigure.disabled = remoteProviderBusy
    cpolarPurge.hidden = !cpolarInstalled && !cpolarConfigured
    cpolarComponentStatus.textContent = !cpolarSupported
      ? '当前仅支持 Windows x64。你仍可选择内置的 Tailscale Funnel。'
      : !cpolarInstalled
        ? '尚未安装。只有点击下方按钮后，才会从 cpolar 官网下载固定版本。'
        : !cpolarConfigured
          ? `官方组件 ${componentVersion} 已校验，下一步只需保存账号令牌。`
          : `官方组件 ${componentVersion} 与本机账号配置已就绪。`
    const state = typeof data.state === 'string' ? data.state : 'error'
    const errorCode = typeof data.errorCode === 'string' ? data.errorCode : ''
    const remoteOrigin = typeof data.origin === 'string' ? data.origin : ''
    remoteLoginUrl = typeof data.loginUrl === 'string' ? data.loginUrl : ''
    const candidateSetupUrl = cpolar ? '' : officialFunnelSetupUrl(data.setupUrl)
    const fallbackSetupUrls: Record<string, string> = {
      funnel_permission_required: 'https://tailscale.com/s/no-funnel',
      funnel_https_required: 'https://tailscale.com/s/https',
      funnel_start_failed: 'https://tailscale.com/s/no-funnel',
    }
    remoteSetupUrl = candidateSetupUrl !== '' ? candidateSetupUrl : (fallbackSetupUrls[errorCode] ?? '')
    const needsFunnelSetup = state === 'error' && remoteSetupUrl !== ''
    remoteReady = remoteRunning && state === 'ready' && remoteOrigin !== ''
    remoteAccess.hidden = !remoteReady
    remoteAccessLink.href = remoteOrigin
    remoteAccessLink.textContent = remoteOrigin
    remoteAccessLink.title = remoteOrigin
    remoteStatus.classList.toggle('is-running', remoteReady)
    const labels: Record<string, string> = {
      off: '远程访问未启用。局域网访问不受影响。',
      unavailable: cpolar ? 'cpolar 尚未安装或未完成本机账号配置。' : '当前电脑缺少 Funnel 运行组件，请重新安装完整插件包。',
      starting: cpolar ? '正在连接 cpolar 国内节点…' : '正在启动 Tailscale 安全通道…',
      'needs-login': '需要在浏览器完成一次 Tailscale 登录。插件不会读取你的密码。',
      connecting: cpolar ? '公网地址已分配，正在启动 DSH 认证网关…' : '登录完成，正在建立公开 HTTPS 地址…',
      ready: '远程访问已就绪。只有已配对设备可以进入 DSH。',
      error: '远程连接未建立。可重新连接，局域网访问仍可正常使用。',
    }
    const errorLabels: Record<string, string> = {
      funnel_permission_required: '登录已完成。请继续授权 Funnel，完成后会自动建立远程连接。',
      funnel_https_required: '登录已完成。请继续授权 Funnel，官方页面会同时启用 HTTPS。',
      funnel_start_failed: '登录已完成。请继续完成 Tailscale Funnel 的首次授权。',
      tailscale_dns_missing: 'Tailscale 暂未提供远程地址。请重新连接并确认已完成登录。',
      gateway_start_failed: '远程网关启动失败。请重新连接，局域网访问不受影响。',
      control_channel_failed: '远程组件连接中断。请重新连接。',
      cpolar_component_missing: 'cpolar 官方组件尚未安装。请先完成上方准备步骤。',
      cpolar_component_invalid: 'cpolar 组件校验失败。请彻底移除后重新安装。',
      cpolar_config_missing: 'cpolar 尚未保存账号令牌。请先完成上方准备步骤。',
      cpolar_config_invalid: 'cpolar 本机配置无效。请重新保存账号令牌。',
      cpolar_port_unavailable: '无法分配本机远程网关端口，请重试。',
      cpolar_launch_failed: 'cpolar 客户端未能启动。',
      cpolar_start_timeout: '连接 cpolar 国内节点超时，请重新连接。',
      cpolar_stopped: 'cpolar 连接已停止。',
      cpolar_exited: 'cpolar 连接意外退出，请重新连接。',
      cpolar_invalid_output: 'cpolar 返回了无法识别的状态。',
      cpolar_invalid_origin: 'cpolar 返回的公网地址未通过校验。',
    }
    remoteStatus.textContent = remoteSetupPending && needsFunnelSetup
      ? 'Tailscale 官方页面已打开。完成启用后返回 DSH，这里会自动重新连接。'
      : (state === 'error' ? (errorLabels[errorCode] ?? labels.error!) : (labels[state] ?? labels.error!))
    remoteGuide.hidden = !needsFunnelSetup
    remoteSetup.disabled = remoteSetupUrl === '' || remoteReconnectBusy
    remoteSetupRetry.disabled = remoteReconnectBusy
    remoteToggle.textContent = remoteRunning ? '关闭远程访问' : '启用远程访问'
    remoteToggle.disabled = remoteProviderBusy || (cpolar && (!cpolarInstalled || !cpolarConfigured))
    remoteLogin.hidden = cpolar || state !== 'needs-login' || remoteLoginUrl === ''
    remoteReconnect.hidden = needsFunnelSetup || (state !== 'error' && state !== 'unavailable')
      || (cpolar && (!cpolarInstalled || !cpolarConfigured))
    remoteActions.hidden = cpolar && (!cpolarInstalled || !cpolarConfigured)
    remotePair.disabled = !remoteReady
    remoteDevices.disabled = !remoteReady
    if (!remoteReady) remoteQr.hidden = true
    if (!needsFunnelSetup) remoteSetupPending = false
  }
  const loadRemote = (): void => {
    void requestJson('/api/mobile-access/remote/control').then(renderRemote, error => { remoteStatus.textContent = String(error) })
  }
  const chooseRemoteProvider = (provider: 'tailscale' | 'cpolar'): void => {
    if (remoteProviderBusy || provider === remoteProvider) return
    if (remoteRunning && !window.confirm('切换连接方式会先关闭当前远程通道。局域网和配对设备不会受影响，是否继续？')) return
    remoteProviderBusy = true
    tailscaleChoice.disabled = true
    cpolarChoice.disabled = true
    remoteStatus.textContent = provider === 'cpolar' ? '正在切换到 cpolar…' : '正在切换到 Tailscale Funnel…'
    void requestJson('/api/mobile-access/remote/provider', { method: 'POST', body: JSON.stringify({ provider }) })
      .then(renderRemote, error => { remoteStatus.textContent = String(error) })
      .finally(() => { remoteProviderBusy = false; loadRemote() })
  }
  tailscaleChoice.addEventListener('click', () => { chooseRemoteProvider('tailscale') })
  cpolarChoice.addEventListener('click', () => { chooseRemoteProvider('cpolar') })
  cpolarInstall.addEventListener('click', () => {
    if (remoteProviderBusy) return
    const accepted = window.confirm('将从 cpolar 官方网站下载并校验固定版本（约 7.3 MB），仅解压到 DSH Mobile 私有目录。不会安装系统服务、写入 PATH/注册表或设置开机启动。是否继续？')
    if (!accepted) return
    remoteProviderBusy = true
    cpolarInstall.disabled = true
    cpolarInstall.textContent = '正在下载并校验…'
    remoteStatus.textContent = '正在安装 cpolar 官方组件。完成前请保持 DSH 运行。'
    void requestJson('/api/mobile-access/remote/cpolar/component/install', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      .then(renderRemote, error => { remoteStatus.textContent = `组件安装失败：${String(error)}` })
      .finally(() => { remoteProviderBusy = false; loadRemote() })
  })
  cpolarConfigure.addEventListener('click', () => {
    if (remoteProviderBusy) return
    const authtoken = cpolarToken.value.trim()
    if (authtoken.length < 20 || /\s/u.test(authtoken)) {
      remoteStatus.textContent = '请粘贴 cpolar 控制台提供的完整 Authtoken。'
      cpolarToken.focus()
      return
    }
    remoteProviderBusy = true
    cpolarConfigure.disabled = true
    cpolarConfigure.setAttribute('aria-busy', 'true')
    cpolarConfigure.textContent = '正在保存…'
    void requestJson('/api/mobile-access/remote/cpolar/configure', { method: 'POST', body: JSON.stringify({ authtoken }) })
      .then(() => {
        cpolarToken.value = ''
        remoteStatus.textContent = '账号配置已保存，正在建立 cpolar 远程通道…'
        return requestJson('/api/mobile-access/remote/control', { method: 'POST', body: JSON.stringify({ running: true }) })
      })
      .then(renderRemote, error => { remoteStatus.textContent = `配置失败：${String(error)}` })
      .finally(() => { remoteProviderBusy = false; cpolarConfigure.setAttribute('aria-busy', 'false'); cpolarConfigure.textContent = '保存并连接'; loadRemote() })
  })
  cpolarPurge.addEventListener('click', () => {
    if (remoteProviderBusy) return
    if (!window.confirm('彻底移除 DSH Mobile 私有目录中的 cpolar 组件、令牌配置和运行日志？不会影响局域网、DSH 数据或系统中的其他程序。')) return
    remoteProviderBusy = true
    cpolarPurge.disabled = true
    remoteStatus.textContent = '正在关闭通道并清理 DSH Mobile 管理的 cpolar 文件…'
    void requestJson('/api/mobile-access/remote/cpolar/component/purge', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      .then(renderRemote, error => { remoteStatus.textContent = `清理失败：${String(error)}` })
      .finally(() => { remoteProviderBusy = false; cpolarPurge.disabled = false; loadRemote() })
  })
  remoteToggle.addEventListener('click', () => {
    remoteToggle.disabled = true
    void requestJson('/api/mobile-access/remote/control', { method: 'POST', body: JSON.stringify({ running: !remoteRunning }) })
      .then(renderRemote, error => { remoteStatus.textContent = String(error) })
      .finally(loadRemote)
  })
  remoteLogin.addEventListener('click', () => {
    if (remoteLoginUrl !== '') window.open(remoteLoginUrl, '_blank', 'noopener,noreferrer')
  })
  const reconnectRemote = (): void => {
    if (remoteReconnectBusy) return
    remoteReconnectBusy = true
    remoteReconnect.disabled = true
    remoteSetup.disabled = true
    remoteSetupRetry.disabled = true
    remoteStatus.textContent = remoteProvider === 'cpolar' ? '正在重新连接 cpolar 国内节点…' : '正在确认 Tailscale 设置并重新连接…'
    void requestJson('/api/mobile-access/remote/reconnect', { method: 'POST', body: '{}' })
      .then(renderRemote, error => { remoteStatus.textContent = String(error) })
      .finally(() => {
        remoteReconnectBusy = false
        remoteReconnect.disabled = false
        remoteSetup.disabled = remoteSetupUrl === ''
        remoteSetupRetry.disabled = false
      })
  }
  remoteReconnect.addEventListener('click', reconnectRemote)
  remoteSetupRetry.addEventListener('click', () => { remoteSetupPending = false; reconnectRemote() })
  remoteSetup.addEventListener('click', () => {
    if (remoteSetupUrl === '') return
    remoteSetupPending = true
    remoteSetupOpenedAt = Date.now()
    remoteStatus.textContent = 'Tailscale 官方页面已打开。完成启用后返回 DSH，这里会自动重新连接。'
    window.open(remoteSetupUrl, '_blank', 'noopener,noreferrer')
  })
  const retryAfterSetup = (): void => {
    if (!remoteSetupPending || document.visibilityState === 'hidden' || Date.now() - remoteSetupOpenedAt < 800) return
    remoteSetupPending = false
    reconnectRemote()
  }
  window.addEventListener('focus', retryAfterSetup)
  document.addEventListener('visibilitychange', retryAfterSetup)
  remotePair.addEventListener('click', () => {
    remotePair.disabled = true
    void requestJson('/api/mobile-access/remote/pairing/open', { method: 'POST', body: '{}' }).then(async data => {
      const pairUrl = typeof data.pairUrl === 'string' ? data.pairUrl : ''
      showQr(typeof data.qrSvg === 'string' ? data.qrSvg : '', remoteQr)
      if (pairUrl !== '') {
        try { await navigator.clipboard.writeText(pairUrl) } catch { /* QR remains the primary remote handoff. */ }
      }
      remoteStatus.textContent = '远程配对二维码已生成。请在 App 的“远程访问”中扫描。'
    }, error => { remoteStatus.textContent = String(error) }).finally(() => { remotePair.disabled = !remoteReady })
  })
  const renderRemoteDevices = (data: Record<string, unknown>): void => {
    const devices = Array.isArray(data.devices) ? data.devices as Record<string, unknown>[] : []
    remoteDevicePanel.replaceChildren()
    if (devices.length === 0) {
      const empty = element('p', 'dsh-mobile-control__device-empty'); empty.textContent = '暂无远程配对设备。'; remoteDevicePanel.append(empty); return
    }
    for (const device of devices) {
      const row = element('div', 'dsh-mobile-control__device')
      const label = element('span', 'dsh-mobile-control__device-label'); label.textContent = typeof device.label === 'string' ? device.label : '设备'
      const meta = element('span', 'dsh-mobile-control__device-meta'); meta.textContent = `到期 ${formatTime(device.expiresAt)}`
      const revoke = element('button', 'dsh-mobile-control__device-revoke'); revoke.type = 'button'; revoke.textContent = '撤销'
      const id = typeof device.id === 'string' ? device.id : ''
      revoke.addEventListener('click', () => {
        void requestJson('/api/mobile-access/remote/devices/revoke', { method: 'POST', body: JSON.stringify({ deviceId: id }) })
          .then(loadRemoteDevices, error => { remoteStatus.textContent = String(error) })
      })
      row.append(label, meta, revoke); remoteDevicePanel.append(row)
    }
  }
  const loadRemoteDevices = (): void => {
    void requestJson('/api/mobile-access/remote/devices').then(renderRemoteDevices, error => { remoteStatus.textContent = String(error) })
  }
  remoteDevices.addEventListener('click', () => {
    const show = remoteDevicePanel.hidden
    remoteDevicePanel.hidden = !show
    if (show) loadRemoteDevices()
  })
  remoteReset.addEventListener('click', () => {
    const prompt = remoteProvider === 'cpolar'
      ? '关闭 cpolar 远程通道并移除所有远程配对设备？不会修改你的 cpolar 账号或其他隧道。'
      : '退出电脑上的 Tailscale 登录并移除所有远程配对设备？局域网配置不会改变。'
    if (!window.confirm(prompt)) return
    void requestJson('/api/mobile-access/remote/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      .then(renderRemote, error => { remoteStatus.textContent = String(error) })
  })
  pair.addEventListener('click', () => { pair.disabled = true; openPairing('key') })
  linkPair.addEventListener('click', () => { linkPair.disabled = true; openPairing('link') })
  close.addEventListener('click', () => { setOpen(false) })
  const dismiss = (event: PointerEvent): void => {
    if (panel.hidden || !(event.target instanceof Node)) return
    if (!providerInfo.contains(event.target)) {
      providerInfoPinned = false
      providerInfoHovered = false
      syncProviderInfo()
    }
    if (!panel.contains(event.target) && !document.querySelector('.dsh-mobile-control__trigger')?.contains(event.target)) setOpen(false)
  }
  document.addEventListener('pointerdown', dismiss)
  void requestJson('/api/mobile-access/lan/control').then(render, error => { status.textContent = String(error) })
  loadRemote()
  const remotePoll = window.setInterval(() => { if (!panel.hidden && !remoteView.hidden) loadRemote() }, 1_500)
  return { remove: () => { window.clearInterval(remotePoll); window.removeEventListener('focus', retryAfterSetup); document.removeEventListener('visibilitychange', retryAfterSetup); document.removeEventListener('pointerdown', dismiss); root.remove() }, toggle: () => { setOpen(panel.hidden !== false) } }
}

function mobileRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(path, location.href)
  if (target.origin !== location.origin) throw new TypeError('mobile extension requests must stay on the DSH origin')
  const headers = new Headers(init.headers)
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('dsh_ma_csrf='))?.slice(12)
    if (csrf !== undefined) headers.set('x-dsh-mobile-csrf', csrf)
  }
  return fetch(target, { ...init, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
}

function installCustomAssets(): () => void {
  const legacyStyle = element('style'); legacyStyle.dataset.plugin = 'dsh-mobile-custom'; document.head.append(legacyStyle)
  const previous = window.dshMobile
  let legacyMount: MobileExtensionMount | undefined = queuedLegacyMount
  let legacySource = ''
  let legacyRoot: HTMLElement | undefined
  let legacyDispose: (() => void) | undefined
  const definitions = new Map<string, MobileClientDefinition>()
  const active = new Map<string, { readonly controller: AbortController; readonly dispose: () => void; readonly surfaces: Map<string, { readonly dispose: () => void; readonly container: HTMLElement }> }>()
  const styleNodes = new Map<string, HTMLStyleElement>()
  const styleEtags = new Map<string, string>()
  const scriptDigests = new Map<string, string>()
  let manifestEtag = ''
  let expectedDefinitionId: string | undefined
  const SURFACE_HOST_STYLES: Readonly<Record<string, string>> = {
    'sidebar-action': 'position:fixed;z-index:1100;top:calc(env(safe-area-inset-top) + 8px);left:8px;display:flex;flex-direction:column;gap:6px;pointer-events:none',
    'header-action': 'position:fixed;z-index:1100;top:calc(env(safe-area-inset-top) + 8px);right:8px;display:flex;flex-direction:column;gap:6px;pointer-events:none',
    'composer-dock': 'position:fixed;z-index:1100;bottom:calc(env(safe-area-inset-bottom) + 8px);left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;pointer-events:none',
    'settings-section': 'position:fixed;z-index:1100;inset:auto 8px calc(env(safe-area-inset-bottom) + 72px) 8px;max-height:40vh;overflow:auto;pointer-events:none',
  }
  const surfaceHost = (placement: string): HTMLElement | undefined => {
    const existing = document.querySelector<HTMLElement>(`[data-dsh-mobile-surface-host="${placement}"]`)
    if (existing !== null) return existing
    const style = SURFACE_HOST_STYLES[placement]
    if (style === undefined) return undefined
    const host = element('div'); host.dataset.dshMobileSurfaceHost = placement; host.style.cssText = style
    document.body.append(host); return host
  }
  const shellLayer = (): HTMLElement => {
    const existing = document.querySelector<HTMLElement>('[data-dsh-mobile-extension-layer]')
    if (existing !== null) return existing
    const layer = element('div'); layer.dataset.dshMobileExtensionLayer = 'true'; layer.style.cssText = 'position:fixed;inset:0;z-index:1200;pointer-events:none;overflow:hidden'
    document.body.append(layer); return layer
  }
  const toast = (message: string): void => {
    const node = element('div'); node.textContent = message; node.style.cssText = 'position:absolute;top:16px;left:50%;transform:translateX(-50%);padding:9px 14px;border-radius:999px;background:#1f2937;color:white;font:14px system-ui;pointer-events:auto;box-shadow:0 8px 24px #0003'
    shellLayer().append(node); window.setTimeout(() => node.remove(), 2600)
  }
  const materializeNativeFile = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || !('base64' in value) || !('name' in value)) return value
    const candidate = value as { base64?: unknown; name?: unknown; type?: unknown }
    if (typeof candidate.base64 !== 'string' || typeof candidate.name !== 'string') return value
    try {
      const encoded = atob(candidate.base64)
      const bytes = Uint8Array.from(encoded, character => character.charCodeAt(0))
      return new File([bytes], candidate.name, { type: typeof candidate.type === 'string' ? candidate.type : 'application/octet-stream' })
    } catch {
      return value
    }
  }
  const invokeNative = async (action: string, input?: unknown): Promise<unknown> => {
    const bridge = window.__DSH_MOBILE_NATIVE__
    if (bridge !== undefined) return materializeNativeFile(await bridge.invoke(action, input))
    if (action === 'share' && typeof navigator.share === 'function') { await navigator.share((input ?? {}) as ShareData); return { ok: true } }
    if (action === 'clipboard.read' && navigator.clipboard !== undefined) return { text: await navigator.clipboard.readText() }
    if (action === 'clipboard.write' && navigator.clipboard !== undefined) { await navigator.clipboard.writeText(typeof input === 'object' && input !== null && 'text' in input ? String((input as { text: unknown }).text) : ''); return { ok: true } }
    if (action === 'files.pick' || action === 'camera.capture') {
      const inputElement = element('input'); inputElement.type = 'file'; inputElement.accept = action === 'camera.capture' ? 'image/*' : '*/*'; if (action === 'camera.capture') inputElement.capture = 'environment';
      return new Promise<File | undefined>(resolve => { inputElement.onchange = () => resolve(inputElement.files?.[0]); inputElement.click() })
    }
    throw new Error('native capability is unavailable')
  }
  const makeApi = (id: string, controller: AbortController): MobileClientApi => {
    const surfaces = active.get(id)?.surfaces ?? new Map()
    const mountSurface = (surface: MobileSurface): (() => void) => {
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(surface.id) || surface.label.length > 120) throw new Error('invalid mobile surface')
      const container = element('section'); container.dataset.dshMobileSurface = surface.id; container.hidden = surface.placement === 'page' || surface.placement === 'overlay'; container.style.cssText = surface.placement === 'page' || surface.placement === 'overlay' ? 'position:absolute;inset:0;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fff);padding:16px;pointer-events:auto' : 'pointer-events:auto'
      const host = surface.placement === 'page' || surface.placement === 'overlay' ? shellLayer() : surfaceHost(surface.placement) ?? shellLayer()
      host.append(container)
      const mounted = surface.mount(container)
      const dispose = (): void => { if (typeof mounted === 'function') mounted(); container.remove() }
      surfaces.set(surface.id, { dispose, container });
      return () => { if (surfaces.get(surface.id)?.dispose === dispose) surfaces.delete(surface.id); dispose() }
    }
    return {
      host: {
        invoke: (action: string, input: unknown) => mobileRequest(`/mobile-access/extensions/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`, { method: 'POST', body: JSON.stringify(input ?? {}) }).then(async response => { const value = await response.json() as unknown; if (!response.ok) throw new Error(typeof value === 'object' && value !== null && 'error' in value ? String((value as { error: unknown }).error) : `HTTP ${String(response.status)}`); return value }),
        fetch: (path: string, init?: RequestInit) => {
          if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')
            || path.split('/').some(part => part === '..' || part === '.')) throw new TypeError('extension routes must be relative')
          return mobileRequest(`/mobile-access/extensions/${encodeURIComponent(id)}/routes${path}`, init)
        },
      },
      ui: { registerSurface: mountSurface, open: id => { const entry = surfaces.get(id); if (entry !== undefined) entry.container.hidden = false }, close: id => { const entry = surfaces.get(id); if (entry !== undefined) entry.container.hidden = true }, toast },
      native: { capabilities: async () => { const bridge = window.__DSH_MOBILE_NATIVE__; return bridge === undefined ? ['files.pick', 'camera.capture', 'share', 'clipboard.read', 'clipboard.write'] : bridge.capabilities() }, invoke: invokeNative },
      signal: controller.signal, document, window,
    }
  }
  const activateDefinition = async (definition: MobileClientDefinition): Promise<void> => {
    const previousActive = active.get(definition.id)
    const controller = new AbortController()
    const surfaces = new Map<string, { readonly dispose: () => void; readonly container: HTMLElement }>()
    active.set(definition.id, { controller, surfaces, dispose: () => { controller.abort(); for (const surface of surfaces.values()) surface.dispose(); surfaces.clear() } })
    try {
      const cleanup = await definition.activate(makeApi(definition.id, controller))
      const current = active.get(definition.id)
      if (current === undefined || current.controller !== controller) { if (typeof cleanup === 'function') cleanup(); return }
      const oldDispose = current.dispose
      active.set(definition.id, { ...current, dispose: () => { if (typeof cleanup === 'function') cleanup(); oldDispose() } })
      previousActive?.dispose()
    } catch {
      active.get(definition.id)?.dispose(); active.delete(definition.id); if (previousActive !== undefined) active.set(definition.id, previousActive)
    }
  }
  const define = (definition: MobileClientDefinition): void => {
    if (definition.apiVersion !== 1 || !/^[a-z][a-z0-9-]{0,63}$/u.test(definition.id) || typeof definition.activate !== 'function') return
    if (expectedDefinitionId !== undefined && definition.id !== expectedDefinitionId) return
    definitions.set(definition.id, definition)
    if (started) void activateDefinition(definition)
  }
  let started = false
  window.dshMobile = Object.freeze({ register: mount => { legacyMount = mount }, define })
  for (const definition of queuedDefinitions.splice(0)) define(definition)
  let legacyJsEtag = ''
  let legacyJsModified = ''
  const refreshLegacy = async (): Promise<void> => {
    try {
      const headers: Record<string, string> = {}
      if (legacyJsEtag !== '') headers['if-none-match'] = legacyJsEtag
      if (legacyJsModified !== '') headers['if-modified-since'] = legacyJsModified
      const response = await fetch('/mobile-access/custom.js', { credentials: 'same-origin', cache: 'no-store', headers })
      if (response.status === 304) return
      if (!response.ok) return
      legacyJsEtag = response.headers.get('etag') ?? ''
      legacyJsModified = response.headers.get('last-modified') ?? ''
      const next = await response.text(); if (next === legacySource) return; legacySource = next; legacyMount = undefined
      const script = element('script'); script.textContent = `${next}\n//# sourceURL=dsh-mobile-custom.js`; document.head.append(script); script.remove()
      const mount = legacyMount as MobileExtensionMount | undefined
      if (mount === undefined) return
      const nextRoot = element('div'); nextRoot.dataset.dshMobileExtension = 'true'; document.body.append(nextRoot)
      const nextDispose = mount({ document, request: mobileRequest, root: nextRoot, window })
      legacyDispose?.(); legacyRoot?.remove(); legacyRoot = nextRoot; legacyDispose = typeof nextDispose === 'function' ? nextDispose : undefined
    } catch { /* Preserve the last good customization during reconnects. */ }
  }
  const refreshExtensions = async (): Promise<void> => {
    try {
      const headers: Record<string, string> = {}
      if (manifestEtag !== '') headers['if-none-match'] = manifestEtag
      const response = await fetch('/mobile-access/extensions/manifest', { credentials: 'same-origin', cache: 'no-store', headers })
      if (response.status === 304) return
      if (!response.ok) return
      manifestEtag = response.headers.get('etag') ?? ''
      const payload = await response.json() as { extensions?: unknown }
      const entries = Array.isArray(payload.extensions) ? payload.extensions as Record<string, unknown>[] : []
      const seen = new Set<string>()
      for (const entry of entries) {
        if (typeof entry.id !== 'string') continue
        seen.add(entry.id)
        const cssUrl = typeof entry.styleUrl === 'string' ? entry.styleUrl : undefined
        if (cssUrl !== undefined) {
          const cssHeaders: Record<string, string> = {}
          const storedEtag = styleEtags.get(entry.id)
          if (storedEtag !== undefined) cssHeaders['if-none-match'] = storedEtag
          const cssResponse = await fetch(cssUrl, { credentials: 'same-origin', cache: 'no-store', headers: cssHeaders })
          if (cssResponse.status === 304) { /* unchanged */ }
          else if (cssResponse.ok) {
            const nextEtag = cssResponse.headers.get('etag'); if (nextEtag !== null && nextEtag !== '') styleEtags.set(entry.id, nextEtag)
            const css = await cssResponse.text(); const oldStyle = styleNodes.get(entry.id)
            if (oldStyle?.textContent !== css) {
              const node = element('style'); node.dataset.dshMobileExtensionStyle = entry.id; node.textContent = css; document.head.append(node); styleNodes.set(entry.id, node); oldStyle?.remove()
            }
          } else continue
        }
        const scriptUrl = typeof entry.scriptUrl === 'string' ? entry.scriptUrl : undefined
        if (scriptUrl !== undefined) {
          const scriptHeaders: Record<string, string> = {}
          const storedDigest = scriptDigests.get(entry.id)
          if (storedDigest !== undefined) scriptHeaders['if-none-match'] = storedDigest
          const scriptResponse = await fetch(scriptUrl, { credentials: 'same-origin', cache: 'no-store', headers: scriptHeaders })
          if (scriptResponse.status === 304) { /* unchanged */ }
          else if (scriptResponse.ok) {
            const source = await scriptResponse.text(); const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)); const key = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
            if (scriptDigests.get(entry.id) !== key) {
              scriptDigests.set(entry.id, key)
              expectedDefinitionId = entry.id
              try { const script = element('script'); script.textContent = `${source}\n//# sourceURL=dsh-mobile-extension-${entry.id}.js`; document.head.append(script); script.remove() }
              finally { expectedDefinitionId = undefined }
            }
          } else continue
        }
        const definition = definitions.get(entry.id); if (definition !== undefined && !active.has(entry.id)) await activateDefinition(definition)
      }
      for (const [id, current] of active) if (!seen.has(id) && !definitions.has(id) && id !== 'legacy-custom') { current.dispose(); active.delete(id); styleNodes.get(id)?.remove(); styleNodes.delete(id); styleEtags.delete(id); scriptDigests.delete(id) }
    } catch { /* A temporary reconnect failure must not tear down the last good UI. */ }
  }
  started = true
  for (const definition of definitions.values()) void activateDefinition(definition)
  void refreshLegacy(); void refreshExtensions(); void refreshCssLegacy(legacyStyle)
  const timer = window.setInterval(() => { void refreshLegacy(); void refreshExtensions(); void refreshCssLegacy(legacyStyle) }, 3_000)
  return () => { clearInterval(timer); started = false; legacyDispose?.(); legacyRoot?.remove(); legacyStyle.remove(); for (const current of active.values()) current.dispose(); for (const node of styleNodes.values()) node.remove(); const layer = document.querySelector('[data-dsh-mobile-extension-layer]'); layer?.remove(); for (const host of document.querySelectorAll('[data-dsh-mobile-surface-host]')) host.remove(); if (previous === undefined) delete window.dshMobile; else window.dshMobile = previous }
}

let cssEtag = ''
let cssModified = ''
async function refreshCssLegacy(style: HTMLStyleElement): Promise<void> {
  try {
    const headers: Record<string, string> = {}
    if (cssEtag !== '') headers['if-none-match'] = cssEtag
    if (cssModified !== '') headers['if-modified-since'] = cssModified
    const response = await fetch('/mobile-access/custom.css', { credentials: 'same-origin', cache: 'no-store', headers })
    if (response.status === 304) return
    if (response.ok) {
      cssEtag = response.headers.get('etag') ?? ''
      cssModified = response.headers.get('last-modified') ?? ''
      style.textContent = await response.text()
    }
  } catch { /* Preserve the last good style during reconnects. */ }
}

const CONTROL_STYLES = `
.dsh-mobile-control{position:fixed;z-index:1000;left:16px;bottom:112px;font:14px/1.45 system-ui;color:var(--dsw-alias-label-primary,#16181d)}
.dsh-mobile-control__panel{box-sizing:border-box;width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 140px);overflow-y:auto;padding:16px;border:1px solid var(--dsw-alias-border-subtle,#e1e5eb);border-radius:18px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 18px 50px rgb(15 23 42 / 18%)}
.dsh-mobile-control__header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}.dsh-mobile-control__panel h2{margin:0;font-size:17px;line-height:24px}.dsh-mobile-control__close{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;border:0;border-radius:10px;background:transparent;color:inherit;font-size:24px;line-height:1;cursor:pointer}.dsh-mobile-control__close:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}
.dsh-mobile-control__app-download{display:flex;align-items:center;justify-content:space-between;box-sizing:border-box;min-height:38px;margin:0 0 10px;padding:8px 11px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:11px;background:var(--dsw-alias-bg-layer-1,#f7f8fa);color:var(--dsw-alias-label-primary,#16181d);font:600 12px/1.3 system-ui;text-decoration:none}.dsh-mobile-control__app-download::after{color:#2563eb;font-size:14px;content:"↗"}.dsh-mobile-control__app-download:hover{border-color:#9fb9e8;background:#f5f8ff;color:#1d4ed8}
.dsh-mobile-control__switcher{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin:0 0 14px;padding:4px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#f3f5f8)}.dsh-mobile-control__tab{min-height:36px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#606873);font:600 13px/1 system-ui;cursor:pointer}.dsh-mobile-control__tab.is-active{background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);box-shadow:0 1px 3px rgb(15 23 42 / 10%)}.dsh-mobile-control__view[hidden]{display:none}.dsh-mobile-control__intro{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#606873);font-size:12px;line-height:1.55}.dsh-mobile-control__view.is-remote .dsh-mobile-control__actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.dsh-mobile-control__view.is-remote .dsh-mobile-control__actions button[hidden]{display:none}
.dsh-mobile-control__provider-section{position:relative;margin:0 0 12px}.dsh-mobile-control__section-title{margin:0 0 8px;color:var(--dsw-alias-label-primary,#16181d);font:650 13px/1.4 system-ui}.dsh-mobile-control__provider-section>.dsh-mobile-control__section-title{padding-right:42px}.dsh-mobile-control__provider-choices{display:grid;gap:8px}.dsh-mobile-control__provider{display:flex;flex-direction:column;gap:5px;min-height:68px;padding:11px 12px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:13px;background:#fff;color:inherit;text-align:left;cursor:pointer;transition:border-color 160ms ease,background-color 160ms ease,box-shadow 160ms ease}.dsh-mobile-control__provider:hover{border-color:#9fb9e8;background:#f8fbff}.dsh-mobile-control__provider.is-selected{border-color:#2563eb;background:#f5f8ff;box-shadow:0 0 0 1px #2563eb inset}.dsh-mobile-control__provider:disabled{cursor:wait;opacity:.62}.dsh-mobile-control__provider-top{display:flex;align-items:center;justify-content:space-between;gap:8px}.dsh-mobile-control__provider-top strong{font-size:13px}.dsh-mobile-control__provider-badge{flex:none;padding:3px 7px;border-radius:999px;background:#e8f0ff;color:#1d4ed8;font:650 10px/1.2 system-ui}.dsh-mobile-control__provider-badge.is-cpolar{background:#eaf8f2;color:#087454}.dsh-mobile-control__provider-description{color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.45}.dsh-mobile-control__provider-info{position:absolute;z-index:5;top:-13px;right:-8px}.dsh-mobile-control__provider-info-button{display:flex;align-items:center;justify-content:center;width:44px;height:44px;padding:0;border:0;border-radius:50%;background:transparent;color:#475569;cursor:pointer;touch-action:manipulation}.dsh-mobile-control__provider-info-button:hover{background:#f1f5f9;color:#1d4ed8}.dsh-mobile-control__provider-info-glyph{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:18px;height:18px;border:1.5px solid currentColor;border-radius:50%;font:700 12px/1 system-ui}.dsh-mobile-control__provider-info-popover{position:absolute;z-index:6;top:38px;right:4px;box-sizing:border-box;width:min(292px,calc(100vw - 72px));padding:10px 12px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 10px 28px rgb(15 23 42 / 16%)}.dsh-mobile-control__provider-info-popover[hidden]{display:none}.dsh-mobile-control__provider-info-popover strong,.dsh-mobile-control__provider-info-popover span{display:block}.dsh-mobile-control__provider-info-popover strong{margin-bottom:3px;font-size:12px}.dsh-mobile-control__provider-info-popover span{color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.55}
.dsh-mobile-control__cpolar-setup{margin:0 0 12px;padding:12px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:13px;background:#fff}.dsh-mobile-control__cpolar-setup[hidden],.dsh-mobile-control__cpolar-account[hidden],.dsh-mobile-control__details[hidden],.dsh-mobile-control__view.is-remote .dsh-mobile-control__actions[hidden],.dsh-mobile-control__danger[hidden]{display:none}.dsh-mobile-control__component-status,.dsh-mobile-control__component-note{margin:0 0 10px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.55}.dsh-mobile-control__cpolar-setup>.dsh-mobile-control__primary{width:100%;min-height:44px;padding:9px 12px;border-radius:10px;font:600 12px/1.3 system-ui;cursor:pointer}.dsh-mobile-control__cpolar-account{margin-top:10px}.dsh-mobile-control__link-row{display:flex;flex-wrap:wrap;gap:6px 12px;margin:0 0 10px}.dsh-mobile-control__text-link{color:#2563eb;font-size:11px;text-decoration:none}.dsh-mobile-control__text-link:hover{text-decoration:underline}.dsh-mobile-control__token-label{display:flex;flex-direction:column;gap:5px;margin:0 0 8px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px}.dsh-mobile-control__token{box-sizing:border-box;width:100%;min-height:44px;padding:9px 10px;border:1px solid var(--dsw-alias-border-normal,#cfd5dd);border-radius:10px;background:#fff;color:inherit;font:16px/1.4 system-ui}.dsh-mobile-control__cpolar-connect{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:100%;min-height:44px;padding:10px 14px;border-radius:12px;font:650 13px/1.2 system-ui;cursor:pointer;transition:background-color 160ms ease,border-color 160ms ease,opacity 160ms ease}.dsh-mobile-control__cpolar-connect:hover:not(:disabled){border-color:#1d4ed8;background:#1d4ed8}.dsh-mobile-control__cpolar-connect:active:not(:disabled){border-color:#1e40af;background:#1e40af}.dsh-mobile-control__cpolar-connect:disabled{cursor:wait;opacity:.55}.dsh-mobile-control__details{margin:10px 0 0;border-top:1px solid var(--dsw-alias-border-subtle,#e1e5eb);padding-top:9px}.dsh-mobile-control__details>summary{min-height:30px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:30px;cursor:pointer}.dsh-mobile-control__details-body{display:flex;flex-wrap:wrap;align-items:center;gap:7px 12px;padding:4px 0}.dsh-mobile-control__details-body p{flex:1 0 100%;margin:0;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5}.dsh-mobile-control__storage{display:block;flex:1 0 100%;max-width:100%;overflow:hidden;padding:7px 8px;border-radius:8px;background:#f3f5f8;color:#475569;font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__danger{flex:1 0 100%;min-height:38px;margin-top:3px;padding:7px 10px;border:1px solid #dc2626;border-radius:9px;background:transparent;color:#b91c1c;font:12px/1.3 system-ui;cursor:pointer}
.dsh-mobile-control__access{display:flex;align-items:baseline;gap:6px;min-width:0;margin:0 0 12px}.dsh-mobile-control__access[hidden]{display:none}.dsh-mobile-control__access-label{flex:none;color:var(--dsw-alias-label-secondary,#606873);white-space:nowrap}.dsh-mobile-control__access-label::after{content:"："}.dsh-mobile-control__access-link{min-width:0;overflow:hidden;color:#2563eb;text-decoration:none;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__access-link:hover{text-decoration:underline}.dsh-mobile-control__qr{display:flex;justify-content:center;margin:0 0 12px}.dsh-mobile-control__qr[hidden]{display:none}.dsh-mobile-control__qr img{border-radius:12px;background:#fff;padding:8px}
.dsh-mobile-control__status{margin:0 0 14px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#606873)}.dsh-mobile-control__status::before{display:inline-block;width:8px;height:8px;margin-right:7px;border-radius:50%;background:#98a1ad;content:""}.dsh-mobile-control__status.is-running::before{background:#16a36a}.dsh-mobile-control__status.is-key{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all}
.dsh-mobile-control__guide{margin:0 0 14px;padding:12px;border:1px solid #bfdbfe;border-radius:12px;background:#eff6ff}.dsh-mobile-control__guide[hidden]{display:none}.dsh-mobile-control__guide-title{margin:0;color:#172554;font:650 13px/1.45 system-ui}.dsh-mobile-control__guide-summary,.dsh-mobile-control__guide-note{margin:4px 0 0;color:#475569;font-size:12px;line-height:1.5}.dsh-mobile-control__guide-steps{margin:8px 0 0;padding-left:20px;color:#1e293b;font-size:12px;line-height:1.6}.dsh-mobile-control__guide-note{color:#64748b}.dsh-mobile-control__guide-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.dsh-mobile-control__guide-actions button{min-width:0;min-height:44px;padding:8px;border-radius:10px;font:12px/1.25 system-ui;cursor:pointer}.dsh-mobile-control__guide-actions button:disabled{cursor:not-allowed;opacity:.45}
.dsh-mobile-control__extensions{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#606873);font-size:12px}
.dsh-mobile-control__actions{display:flex;flex-wrap:nowrap;gap:6px}.dsh-mobile-control__actions button{flex:1 1 0;min-width:0;min-height:40px;padding:8px 4px;border-radius:10px;font:12px/1.2 system-ui;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsh-mobile-control__secondary{border:1px solid var(--dsw-alias-border-normal,#cfd5dd);background:transparent;color:inherit}.dsh-mobile-control__primary{border:1px solid #2563eb;background:#2563eb;color:#fff}.dsh-mobile-control__actions button:disabled{cursor:not-allowed;opacity:.45}
.dsh-mobile-control button:focus-visible,.dsh-mobile-control a:focus-visible,.dsh-mobile-control input:focus-visible,.dsh-mobile-control summary:focus-visible{outline:3px solid rgb(37 99 235 / 28%);outline-offset:2px}
.dsh-mobile-control__trigger{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:calc(100% + 8px);height:34px;margin:4px -4px;padding:6px 2px 6px 10px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary,#16181d);font:14px/22px system-ui;cursor:pointer}.dsh-mobile-control__trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}.dsh-mobile-control__trigger.is-rail{width:36px;height:36px;margin:8px 0 10px;padding:0;justify-content:center;border-radius:50%}.dsh-mobile-control__trigger-icon{position:relative;box-sizing:border-box;flex:none;width:14px;height:19px;border:1.7px solid currentColor;border-radius:3px}.dsh-mobile-control__trigger-icon::after{position:absolute;right:4px;bottom:2px;width:4px;height:1.5px;border-radius:2px;background:currentColor;content:""}.dsh-mobile-control__trigger-label{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dsh-mobile-control__manage-row{display:flex;justify-content:space-between;gap:8px;margin-top:10px}.dsh-mobile-control__manage{flex:1 1 0;min-width:0;min-height:34px;padding:6px 8px;border:1px solid var(--dsw-alias-border-normal,#cfd5dd);border-radius:10px;background:transparent;color:inherit;font:12px/1.3 system-ui;cursor:pointer}.dsh-mobile-control__devices{margin-top:10px;border:1px solid var(--dsw-alias-border-subtle,#e1e5eb);border-radius:10px;padding:8px;max-height:220px;overflow-y:auto}.dsh-mobile-control__device-empty{color:var(--dsw-alias-label-secondary,#606873);font-size:12px;margin:0}.dsh-mobile-control__device{display:flex;align-items:center;gap:8px;padding:6px 2px}.dsh-mobile-control__device + .dsh-mobile-control__device{border-top:1px solid var(--dsw-alias-border-subtle,#e1e5eb)}.dsh-mobile-control__device-label{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.dsh-mobile-control__device-meta{flex:none;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;white-space:nowrap}.dsh-mobile-control__device-revoke{flex:none;min-height:28px;padding:4px 8px;border:1px solid #dc2626;border-radius:8px;background:transparent;color:#dc2626;font:12px/1.2 system-ui;cursor:pointer}
@media (prefers-reduced-motion:reduce){.dsh-mobile-control__provider,.dsh-mobile-control__cpolar-connect{transition:none}}
`

/** Mount the desktop control or mobile feature enhancements. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    if (window.__DSH_MOBILE_FRONTEND__ !== 'dedicated') return
    return trustAuthenticatedGatewayConnection(ctx.get('connection'))
  }, 'dsh-mobile: authenticated gateway client trust')

  ctx.effect(() => {
    const loopback = isLoopbackHost(location.hostname) && !new URLSearchParams(location.search).has('dsh-mobile-preview')
    const style = element('style'); style.dataset.plugin = 'dsh-mobile'; style.textContent = loopback
      ? CONTROL_STYLES
      : NATIVE_MOBILE_STYLES
    document.head.append(style)
    if (!loopback) {
      const removeCustom = installCustomAssets()
      const removeSurface = installNativeMobileSurface()
      return () => { removeCustom(); removeSurface(); style.remove() }
    }
    const control = installControl()
    const disposeSlot = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-mobile' }, ({ wide }) => createElement('button', {
      'aria-expanded': false,
      'aria-label': '移动访问',
      className: `dsh-mobile-control__trigger${wide ? '' : ' is-rail'}`,
      type: 'button',
      title: '移动访问',
      onClick: control.toggle,
    }, createElement('span', { 'aria-hidden': true, className: 'dsh-mobile-control__trigger-icon' }), wide ? createElement('span', { className: 'dsh-mobile-control__trigger-label' }, '移动访问') : undefined)))
    return () => { disposeSlot(); control.remove(); style.remove() }
  }, 'dsh-mobile: stock mobile adaptation and local control')
}

/** Client services required by the mobile adaptation. */
export const inject: readonly string[] = ['slots']
