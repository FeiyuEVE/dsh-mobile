import { createElement } from 'react'
import { installNativeMobileSurface, NATIVE_MOBILE_STYLES } from './native-mobile.js'

interface ClientContext {
  effect(effect: () => void | (() => void), label?: string): void
  get(name: 'connection'): MobileConnectionHandle
  slots: {
    inject(key: string, callback: () => (() => void)): () => void
    register<Props>(options: { name: string; id: string; order?: number; label?: string }, component: (props: Props) => unknown): () => void
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

export type MobileControlLocale = 'it' | 'en' | 'zh'

export const MOBILE_CONTROL_MESSAGES = {
  en: {
    mobileAccess: 'Mobile access', collapseMobileAccess: 'Collapse Mobile access', downloadAndroid: 'Download Android app', downloadAndroidAria: 'Download the latest Android app from GitHub Releases',
    lan: 'Local network', remote: 'Remote', lanAccess: 'Local network access', remoteAccess: 'Remote access', browserAccess: 'Browser access', remoteAddress: 'Remote address', loadingStatus: 'Loading status…', loadingRemoteStatus: 'Loading remote status…',
    generateCopyKey: 'Generate and copy key', copyPairLink: 'Copy pairing link', managePairedDevices: 'Manage paired devices', clearAllDevices: 'Clear all devices', pairingQr: 'Pairing QR code',
    remoteIntro: 'Choose the remote channel that suits you. Switching or disabling remote access does not affect the local network.', chooseProvider: 'Choose connection method', providerInfoAria: 'View remote connection security and network information', providerGroupAria: 'Remote connection method', providerSafeTitle: 'You remain protected', providerSafeText: 'Only paired devices can access DSH. cpolar is installed on demand and can be removed completely; Tailscale may be slow or unavailable on mainland China networks, where cpolar is recommended.',
    builtIn: 'Built in', mainlandPreferred: 'Preferred in mainland China', tailscaleDescription: 'Wider coverage; mainland China networks may be unstable. The first connection requires login and Funnel authorization.', cpolarDescription: 'Installs the official component on demand and is suitable for mainland China networks.',
    prepareCpolar: 'Prepare cpolar', checkingComponent: 'Checking component…', installOfficial: 'Install official component', cpolarAccountNote: 'Sign in to the cpolar website and copy the Authtoken. The token is stored only in the plugin private directory and is never shown on the page or in logs.', registerCpolar: 'Register with cpolar', openDashboard: 'Open dashboard to get token', tokenPlaceholder: 'Paste cpolar Authtoken', saveConnect: 'Save and connect', saving: 'Saving…', componentDetails: 'Component source and cleanup', componentDetailsText: 'Downloaded from the official cpolar website and verified at a fixed version only after you choose Install. It does not add a system service, startup item, registry entry, or PATH entry.', pluginPrivateDirectory: 'Plugin private directory', officialDownload: 'Official download page', terms: 'Terms of service', purgeCpolar: 'Completely remove cpolar component and configuration', tailscaleHelp: 'How to use Tailscale', tailscaleHelpText: 'The runtime component is included with the plugin. The first connection opens the official Tailscale login and Funnel authorization pages; the plugin never accesses your account password.',
    funnelGuideAria: 'Steps to enable Tailscale Funnel', funnelGuideTitle: 'Remote access setup · Step 2', funnelGuideSummary: 'Tailscale login is complete. Funnel must still be allowed for this computer; the official page also enables HTTPS.', funnelStep1: 'Open the official Tailscale authorization page for this node.', funnelStep2: 'Confirm Funnel; you do not need to sign in to DSH again.', funnelStep3: 'Return to DSH; the plugin checks and connects automatically.', funnelGuideNote: 'Requires an Owner, Admin, or Network admin account.', continueFunnel: 'Continue Funnel authorization', retryNow: 'Done, retry now',
    enableRemote: 'Enable remote access', disableRemote: 'Disable remote access', continueLogin: 'Continue login', reconnect: 'Reconnect', generateRemoteQr: 'Generate remote pairing QR code', manageRemoteDevices: 'Manage remote devices', resetRemoteLogin: 'Sign out and clear remote login', resetRemoteDevices: 'Disable and clear remote devices',
    lanOn: 'Local network access is on.', lanOff: 'Local network access is off.', enableLan: 'Enable local network access', disableLan: 'Disable local network access', extensionsLoaded: 'Extensions: {loaded} loaded', extensionsFailed: 'Extensions: {loaded} loaded, {failed} failed',
    keyGenerationFailed: 'Could not generate a pairing key.', keyCopied: 'Pairing key copied. Paste it into the Android app.', linkCopied: 'Pairing link copied. Send it to the phone and paste it into the app or open it in a browser.', copySecret: 'Copy {kind}: {value}', pairingKey: 'pairing key', pairingLink: 'pairing link', noDevices: 'No paired devices.', noRemoteDevices: 'No remote paired devices.', device: 'Device', expires: 'Expires {time}', revoke: 'Revoke', confirmResetDevices: 'Remove all paired devices? Connected devices will be disconnected immediately.',
    ready: 'Ready', installed: 'Installed', installWithSize: 'Install official component · {size} MB', cpolarUnsupported: 'Only Windows x64 is currently supported. You can still use the built-in Tailscale Funnel.', cpolarNotInstalled: 'Not installed. A fixed version is downloaded from the official cpolar website only after you click the button below.', cpolarNeedsToken: 'Official component {version} is verified. Save the account token to continue.', cpolarReady: 'Official component {version} and the local account configuration are ready.',
    remoteOff: 'Remote access is disabled. Local network access is unaffected.', remoteUnavailableCpolar: 'cpolar is not installed or its local account is not configured.', remoteUnavailableTailscale: 'This computer is missing the Funnel runtime component. Reinstall the complete plugin package.', remoteStartingCpolar: 'Connecting to a cpolar node…', remoteStartingTailscale: 'Starting the secure Tailscale channel…', remoteNeedsLogin: 'Complete a one-time Tailscale login in the browser. The plugin never reads your password.', remoteConnectingCpolar: 'Public address allocated; starting the DSH authentication gateway…', remoteConnectingTailscale: 'Login complete; creating the public HTTPS address…', remoteReady: 'Remote access is ready. Only paired devices can access DSH.', remoteError: 'The remote connection was not established. Reconnect; local network access still works.',
    funnelPermission: 'Login is complete. Authorize Funnel to establish the remote connection automatically.', funnelHttps: 'Login is complete. Authorize Funnel; the official page also enables HTTPS.', funnelStart: 'Login is complete. Finish the initial Tailscale Funnel authorization.', tailscaleDnsMissing: 'Tailscale has not provided a remote address. Reconnect and confirm login is complete.', gatewayStartFailed: 'The remote gateway failed to start. Reconnect; local network access is unaffected.', controlChannelFailed: 'The remote component connection was interrupted. Reconnect.', cpolarMissing: 'The official cpolar component is not installed. Complete the preparation steps above.', cpolarInvalid: 'cpolar component verification failed. Remove it completely and reinstall.', cpolarConfigMissing: 'No cpolar account token is saved. Complete the preparation steps above.', cpolarConfigInvalid: 'The local cpolar configuration is invalid. Save the account token again.', cpolarPortUnavailable: 'Could not allocate a local remote-gateway port. Try again.', cpolarLaunchFailed: 'The cpolar client failed to start.', cpolarTimeout: 'Timed out connecting to a cpolar node. Reconnect.', cpolarStopped: 'The cpolar connection stopped.', cpolarExited: 'The cpolar connection exited unexpectedly. Reconnect.', cpolarOutputInvalid: 'cpolar returned an unrecognized status.', cpolarOriginInvalid: 'The public address returned by cpolar failed validation.', setupOpened: 'The official Tailscale page is open. Return to DSH after enabling Funnel; reconnection is automatic.',
    switchProviderConfirm: 'Switching connection method first disables the current remote channel. Local network access and paired devices are unaffected. Continue?', switchingCpolar: 'Switching to cpolar…', switchingTailscale: 'Switching to Tailscale Funnel…', installConfirm: 'Download and verify a fixed version from the official cpolar website (about 7.3 MB) and extract it only to the DSH Mobile private directory? No system service, PATH/registry entry, or startup item is added.', downloading: 'Downloading and verifying…', installingCpolar: 'Installing the official cpolar component. Keep DSH running until it completes.', installFailed: 'Component installation failed: {error}', invalidToken: 'Paste the complete Authtoken from the cpolar dashboard.', configuredConnecting: 'Account configuration saved; connecting through cpolar…', configureFailed: 'Configuration failed: {error}', purgeConfirm: 'Completely remove the cpolar component, token configuration, and runtime logs from the DSH Mobile private directory? Local network access, DSH data, and other system programs are unaffected.', purging: 'Stopping the channel and removing cpolar files managed by DSH Mobile…', purgeFailed: 'Cleanup failed: {error}', reconnectingCpolar: 'Reconnecting to a cpolar node…', reconnectingTailscale: 'Checking Tailscale settings and reconnecting…', remoteQrReady: 'Remote pairing QR code generated. Scan it from “Remote access” in the app.', resetCpolarConfirm: 'Disable the cpolar remote channel and remove all remote paired devices? Your cpolar account and other tunnels are unchanged.', resetTailscaleConfirm: 'Sign out of Tailscale on this computer and remove all remote paired devices? Local network configuration is unchanged.', requestFailed: 'Request failed: {error}',
  },
  it: {
    mobileAccess: 'Accesso mobile', collapseMobileAccess: 'Riduci Accesso mobile', downloadAndroid: 'Scarica app Android', downloadAndroidAria: 'Scarica l’ultima app Android da GitHub Releases',
    lan: 'Rete locale', remote: 'Remoto', lanAccess: 'Accesso rete locale', remoteAccess: 'Accesso remoto', browserAccess: 'Accesso browser', remoteAddress: 'Indirizzo remoto', loadingStatus: 'Lettura stato…', loadingRemoteStatus: 'Lettura stato remoto…',
    generateCopyKey: 'Genera e copia chiave', copyPairLink: 'Copia link di abbinamento', managePairedDevices: 'Gestisci dispositivi abbinati', clearAllDevices: 'Rimuovi tutti i dispositivi', pairingQr: 'Codice QR di abbinamento', remoteIntro: 'Scegli il canale remoto più adatto. Cambiare o disattivare l’accesso remoto non influisce sulla rete locale.', chooseProvider: 'Scegli metodo di connessione', providerInfoAria: 'Informazioni su sicurezza e rete della connessione remota', providerGroupAria: 'Metodo di connessione remota', providerSafeTitle: 'La protezione resta attiva', providerSafeText: 'Solo i dispositivi abbinati possono accedere a DSH. cpolar viene installato su richiesta e può essere rimosso completamente; Tailscale può essere lento o non disponibile nelle reti della Cina continentale, dove è consigliato cpolar.',
    builtIn: 'Integrato', mainlandPreferred: 'Preferito in Cina continentale', tailscaleDescription: 'Copertura più ampia; le reti della Cina continentale possono essere instabili. Il primo collegamento richiede accesso e autorizzazione Funnel.', cpolarDescription: 'Installa su richiesta il componente ufficiale, adatto alle reti della Cina continentale.', prepareCpolar: 'Prepara cpolar', checkingComponent: 'Controllo componente…', installOfficial: 'Installa componente ufficiale', cpolarAccountNote: 'Accedi al sito cpolar e copia l’Authtoken. Il token resta solo nella directory privata del plugin e non viene mostrato nella pagina o nei log.', registerCpolar: 'Registrati su cpolar', openDashboard: 'Apri la dashboard per il token', tokenPlaceholder: 'Incolla Authtoken cpolar', saveConnect: 'Salva e connetti', saving: 'Salvataggio…', componentDetails: 'Origine e rimozione del componente', componentDetailsText: 'Viene scaricato dal sito ufficiale cpolar e verificato a una versione fissa solo dopo aver scelto Installa. Non aggiunge servizi di sistema, avvio automatico, voci di registro o PATH.', pluginPrivateDirectory: 'Directory privata del plugin', officialDownload: 'Pagina download ufficiale', terms: 'Termini di servizio', purgeCpolar: 'Rimuovi completamente componente e configurazione cpolar', tailscaleHelp: 'Guida a Tailscale', tailscaleHelpText: 'Il componente runtime è incluso nel plugin. Il primo collegamento apre le pagine ufficiali di accesso Tailscale e autorizzazione Funnel; il plugin non accede mai alla password.', funnelGuideAria: 'Passaggi per abilitare Tailscale Funnel', funnelGuideTitle: 'Configurazione accesso remoto · Passaggio 2', funnelGuideSummary: 'L’accesso Tailscale è completato. Devi ancora consentire Funnel per questo computer; la pagina ufficiale abilita anche HTTPS.', funnelStep1: 'Apri la pagina ufficiale di autorizzazione Tailscale per questo nodo.', funnelStep2: 'Conferma Funnel; non serve accedere di nuovo a DSH.', funnelStep3: 'Torna in DSH; il plugin controlla e si connette automaticamente.', funnelGuideNote: 'Richiede un account Owner, Admin o Network admin.', continueFunnel: 'Continua autorizzazione Funnel', retryNow: 'Fatto, riprova ora', enableRemote: 'Attiva accesso remoto', disableRemote: 'Disattiva accesso remoto', continueLogin: 'Continua accesso', reconnect: 'Riconnetti', generateRemoteQr: 'Genera QR di abbinamento remoto', manageRemoteDevices: 'Gestisci dispositivi remoti', resetRemoteLogin: 'Esci e rimuovi accesso remoto', resetRemoteDevices: 'Disattiva e rimuovi dispositivi remoti',
    lanOn: 'Accesso dalla rete locale attivo.', lanOff: 'Accesso dalla rete locale disattivato.', enableLan: 'Attiva accesso rete locale', disableLan: 'Disattiva accesso rete locale', extensionsLoaded: 'Estensioni: {loaded} caricate', extensionsFailed: 'Estensioni: {loaded} caricate, {failed} non riuscite', keyGenerationFailed: 'Impossibile generare la chiave di abbinamento.', keyCopied: 'Chiave di abbinamento copiata. Incollala nell’app Android.', linkCopied: 'Link di abbinamento copiato. Invialo al telefono e incollalo nell’app oppure aprilo nel browser.', copySecret: 'Copia {kind}: {value}', pairingKey: 'chiave di abbinamento', pairingLink: 'link di abbinamento', noDevices: 'Nessun dispositivo abbinato.', noRemoteDevices: 'Nessun dispositivo remoto abbinato.', device: 'Dispositivo', expires: 'Scade {time}', revoke: 'Revoca', confirmResetDevices: 'Rimuovere tutti i dispositivi abbinati? I dispositivi connessi verranno disconnessi subito.', ready: 'Pronto', installed: 'Installato', installWithSize: 'Installa componente ufficiale · {size} MB', cpolarUnsupported: 'Attualmente è supportato solo Windows x64. Puoi comunque usare Tailscale Funnel integrato.', cpolarNotInstalled: 'Non installato. Una versione fissa viene scaricata dal sito ufficiale cpolar solo dopo aver premuto il pulsante.', cpolarNeedsToken: 'Componente ufficiale {version} verificato. Salva il token account per continuare.', cpolarReady: 'Componente ufficiale {version} e configurazione account locale pronti.',
    remoteOff: 'Accesso remoto disattivato. La rete locale non è interessata.', remoteUnavailableCpolar: 'cpolar non è installato o l’account locale non è configurato.', remoteUnavailableTailscale: 'Su questo computer manca il componente runtime Funnel. Reinstalla il pacchetto completo del plugin.', remoteStartingCpolar: 'Connessione a un nodo cpolar…', remoteStartingTailscale: 'Avvio del canale sicuro Tailscale…', remoteNeedsLogin: 'Completa una volta l’accesso Tailscale nel browser. Il plugin non legge mai la password.', remoteConnectingCpolar: 'Indirizzo pubblico assegnato; avvio del gateway di autenticazione DSH…', remoteConnectingTailscale: 'Accesso completato; creazione dell’indirizzo HTTPS pubblico…', remoteReady: 'Accesso remoto pronto. Solo i dispositivi abbinati possono accedere a DSH.', remoteError: 'Connessione remota non stabilita. Riconnettiti; la rete locale continua a funzionare.', funnelPermission: 'Accesso completato. Autorizza Funnel per stabilire automaticamente la connessione remota.', funnelHttps: 'Accesso completato. Autorizza Funnel; la pagina ufficiale abilita anche HTTPS.', funnelStart: 'Accesso completato. Termina la prima autorizzazione Tailscale Funnel.', tailscaleDnsMissing: 'Tailscale non ha fornito un indirizzo remoto. Riconnettiti e verifica di aver completato l’accesso.', gatewayStartFailed: 'Avvio del gateway remoto non riuscito. Riconnettiti; la rete locale non è interessata.', controlChannelFailed: 'Connessione al componente remoto interrotta. Riconnettiti.', cpolarMissing: 'Il componente ufficiale cpolar non è installato. Completa i passaggi sopra.', cpolarInvalid: 'Verifica del componente cpolar non riuscita. Rimuovilo completamente e reinstallalo.', cpolarConfigMissing: 'Nessun token account cpolar salvato. Completa i passaggi sopra.', cpolarConfigInvalid: 'Configurazione locale cpolar non valida. Salva nuovamente il token.', cpolarPortUnavailable: 'Impossibile assegnare una porta locale al gateway remoto. Riprova.', cpolarLaunchFailed: 'Avvio del client cpolar non riuscito.', cpolarTimeout: 'Connessione al nodo cpolar scaduta. Riconnettiti.', cpolarStopped: 'Connessione cpolar arrestata.', cpolarExited: 'Connessione cpolar terminata inaspettatamente. Riconnettiti.', cpolarOutputInvalid: 'cpolar ha restituito uno stato non riconosciuto.', cpolarOriginInvalid: 'L’indirizzo pubblico restituito da cpolar non ha superato la verifica.', setupOpened: 'La pagina ufficiale Tailscale è aperta. Torna in DSH dopo aver abilitato Funnel; la riconnessione è automatica.',
    switchProviderConfirm: 'Il cambio di metodo disattiva prima il canale remoto corrente. Rete locale e dispositivi abbinati non sono interessati. Continuare?', switchingCpolar: 'Passaggio a cpolar…', switchingTailscale: 'Passaggio a Tailscale Funnel…', installConfirm: 'Scaricare e verificare una versione fissa dal sito ufficiale cpolar (circa 7,3 MB), estraendola solo nella directory privata DSH Mobile? Non vengono aggiunti servizi, PATH/registro o avvio automatico.', downloading: 'Download e verifica…', installingCpolar: 'Installazione del componente ufficiale cpolar. Mantieni DSH in esecuzione fino al termine.', installFailed: 'Installazione componente non riuscita: {error}', invalidToken: 'Incolla l’Authtoken completo dalla dashboard cpolar.', configuredConnecting: 'Configurazione account salvata; connessione tramite cpolar…', configureFailed: 'Configurazione non riuscita: {error}', purgeConfirm: 'Rimuovere completamente componente cpolar, configurazione token e log runtime dalla directory privata DSH Mobile? Rete locale, dati DSH e altri programmi non sono interessati.', purging: 'Arresto del canale e rimozione dei file cpolar gestiti da DSH Mobile…', purgeFailed: 'Pulizia non riuscita: {error}', reconnectingCpolar: 'Riconnessione a un nodo cpolar…', reconnectingTailscale: 'Controllo impostazioni Tailscale e riconnessione…', remoteQrReady: 'QR di abbinamento remoto generato. Scansionalo da “Accesso remoto” nell’app.', resetCpolarConfirm: 'Disattivare il canale remoto cpolar e rimuovere tutti i dispositivi remoti? Account cpolar e altri tunnel restano invariati.', resetTailscaleConfirm: 'Uscire da Tailscale su questo computer e rimuovere tutti i dispositivi remoti? La configurazione della rete locale resta invariata.', requestFailed: 'Richiesta non riuscita: {error}',
  },
  zh: {} as Record<string, string>,
} satisfies Record<MobileControlLocale, Record<string, string>>

Object.assign(MOBILE_CONTROL_MESSAGES.zh, {
  mobileAccess: '移动访问', collapseMobileAccess: '收起移动访问', downloadAndroid: '下载 Android App', downloadAndroidAria: '前往 GitHub Releases 下载最新版 Android App', lan: '局域网', remote: '远程', lanAccess: '局域网访问', remoteAccess: '远程访问', browserAccess: '浏览器访问', remoteAddress: '远程地址', loadingStatus: '正在读取状态…', loadingRemoteStatus: '正在读取远程状态…',
  generateCopyKey: '生成并复制密钥', copyPairLink: '复制配对链接', managePairedDevices: '管理配对设备', clearAllDevices: '清除所有设备', pairingQr: '配对二维码', remoteIntro: '选择更适合你的远程通道。切换或关闭远程访问不会影响局域网。', chooseProvider: '选择连接方式', providerInfoAria: '查看远程连接安全与网络说明', providerGroupAria: '远程连接方式', providerSafeTitle: '你始终可以放心', providerSafeText: '只有已配对设备能进入 DSH。cpolar 按需安装并可彻底清理；Tailscale 在中国大陆网络下可能连接缓慢、中断或无法使用，国内网络建议优先尝试 cpolar。', builtIn: '内置', mainlandPreferred: '国内网络优先', tailscaleDescription: '覆盖更广；中国大陆网络可能不稳定，首次需登录并允许 Funnel。', cpolarDescription: '按需安装官方组件，适合国内网络环境。',
  prepareCpolar: '准备 cpolar', checkingComponent: '正在检查组件…', installOfficial: '安装官方组件', cpolarAccountNote: '登录 cpolar 官网后复制 Authtoken。令牌只保存在本机插件私有目录，不会显示在页面或日志中。', registerCpolar: '注册 cpolar', openDashboard: '打开控制台获取令牌', tokenPlaceholder: '粘贴 cpolar Authtoken', saveConnect: '保存并连接', saving: '正在保存…', componentDetails: '组件来源与清理说明', componentDetailsText: '仅在你点击安装后从 cpolar 官网下载并校验固定版本。不会写入系统服务、开机启动、注册表或 PATH。', pluginPrivateDirectory: '插件私有目录', officialDownload: '官方下载安装页', terms: '服务条款', purgeCpolar: '彻底移除 cpolar 组件与配置', tailscaleHelp: 'Tailscale 使用说明', tailscaleHelpText: '运行组件已随插件提供。首次连接会打开 Tailscale 官方登录和 Funnel 授权页；插件不会接触你的账号密码。', funnelGuideAria: 'Tailscale Funnel 启用步骤', funnelGuideTitle: '远程访问设置 · 第 2 步', funnelGuideSummary: 'Tailscale 登录已完成。还需为这台电脑允许 Funnel，官方页面会同时启用 HTTPS。', funnelStep1: '打开当前节点的 Tailscale 官方授权页。', funnelStep2: '确认启用 Funnel；无需再次登录 DSH。', funnelStep3: '返回 DSH，插件会自动检查并建立连接。', funnelGuideNote: '需要使用 Owner、Admin 或 Network admin 账号。', continueFunnel: '继续完成 Funnel 授权', retryNow: '已完成，立即重试',
  enableRemote: '启用远程访问', disableRemote: '关闭远程访问', continueLogin: '继续登录', reconnect: '重新连接', generateRemoteQr: '生成远程配对二维码', manageRemoteDevices: '管理远程设备', resetRemoteLogin: '退出并清除远程登录', resetRemoteDevices: '关闭并清除远程设备', lanOn: '局域网访问已开启。', lanOff: '局域网访问已关闭。', enableLan: '开启局域网访问', disableLan: '关闭局域网访问', extensionsLoaded: '扩展：{loaded} 个已加载', extensionsFailed: '扩展：{loaded} 个已加载，{failed} 个加载失败', keyGenerationFailed: '无法生成配对密钥。', keyCopied: '配对密钥已复制，请粘贴到 Android App。', linkCopied: '配对链接已复制，发给手机后 App 粘贴或浏览器打开即可配对。', copySecret: '请复制{kind}：{value}', pairingKey: '配对密钥', pairingLink: '配对链接', noDevices: '暂无配对设备。', noRemoteDevices: '暂无远程配对设备。', device: '设备', expires: '到期 {time}', revoke: '撤销', confirmResetDevices: '确定要移除所有配对设备吗？此操作会立即终止已连接设备。', ready: '已就绪', installed: '已安装', installWithSize: '安装官方组件 · {size} MB',
  cpolarUnsupported: '当前仅支持 Windows x64。你仍可选择内置的 Tailscale Funnel。', cpolarNotInstalled: '尚未安装。只有点击下方按钮后，才会从 cpolar 官网下载固定版本。', cpolarNeedsToken: '官方组件 {version} 已校验，下一步只需保存账号令牌。', cpolarReady: '官方组件 {version} 与本机账号配置已就绪。', remoteOff: '远程访问未启用。局域网访问不受影响。', remoteUnavailableCpolar: 'cpolar 尚未安装或未完成本机账号配置。', remoteUnavailableTailscale: '当前电脑缺少 Funnel 运行组件，请重新安装完整插件包。', remoteStartingCpolar: '正在连接 cpolar 国内节点…', remoteStartingTailscale: '正在启动 Tailscale 安全通道…', remoteNeedsLogin: '需要在浏览器完成一次 Tailscale 登录。插件不会读取你的密码。', remoteConnectingCpolar: '公网地址已分配，正在启动 DSH 认证网关…', remoteConnectingTailscale: '登录完成，正在建立公开 HTTPS 地址…', remoteReady: '远程访问已就绪。只有已配对设备可以进入 DSH。', remoteError: '远程连接未建立。可重新连接，局域网访问仍可正常使用。',
  funnelPermission: '登录已完成。请继续授权 Funnel，完成后会自动建立远程连接。', funnelHttps: '登录已完成。请继续授权 Funnel，官方页面会同时启用 HTTPS。', funnelStart: '登录已完成。请继续完成 Tailscale Funnel 的首次授权。', tailscaleDnsMissing: 'Tailscale 暂未提供远程地址。请重新连接并确认已完成登录。', gatewayStartFailed: '远程网关启动失败。请重新连接，局域网访问不受影响。', controlChannelFailed: '远程组件连接中断。请重新连接。', cpolarMissing: 'cpolar 官方组件尚未安装。请先完成上方准备步骤。', cpolarInvalid: 'cpolar 组件校验失败。请彻底移除后重新安装。', cpolarConfigMissing: 'cpolar 尚未保存账号令牌。请先完成上方准备步骤。', cpolarConfigInvalid: 'cpolar 本机配置无效。请重新保存账号令牌。', cpolarPortUnavailable: '无法分配本机远程网关端口，请重试。', cpolarLaunchFailed: 'cpolar 客户端未能启动。', cpolarTimeout: '连接 cpolar 国内节点超时，请重新连接。', cpolarStopped: 'cpolar 连接已停止。', cpolarExited: 'cpolar 连接意外退出，请重新连接。', cpolarOutputInvalid: 'cpolar 返回了无法识别的状态。', cpolarOriginInvalid: 'cpolar 返回的公网地址未通过校验。', setupOpened: 'Tailscale 官方页面已打开。完成启用后返回 DSH，这里会自动重新连接。',
  switchProviderConfirm: '切换连接方式会先关闭当前远程通道。局域网和配对设备不会受影响，是否继续？', switchingCpolar: '正在切换到 cpolar…', switchingTailscale: '正在切换到 Tailscale Funnel…', installConfirm: '将从 cpolar 官方网站下载并校验固定版本（约 7.3 MB），仅解压到 DSH Mobile 私有目录。不会安装系统服务、写入 PATH/注册表或设置开机启动。是否继续？', downloading: '正在下载并校验…', installingCpolar: '正在安装 cpolar 官方组件。完成前请保持 DSH 运行。', installFailed: '组件安装失败：{error}', invalidToken: '请粘贴 cpolar 控制台提供的完整 Authtoken。', configuredConnecting: '账号配置已保存，正在建立 cpolar 远程通道…', configureFailed: '配置失败：{error}', purgeConfirm: '彻底移除 DSH Mobile 私有目录中的 cpolar 组件、令牌配置和运行日志？不会影响局域网、DSH 数据或系统中的其他程序。', purging: '正在关闭通道并清理 DSH Mobile 管理的 cpolar 文件…', purgeFailed: '清理失败：{error}', reconnectingCpolar: '正在重新连接 cpolar 国内节点…', reconnectingTailscale: '正在确认 Tailscale 设置并重新连接…', remoteQrReady: '远程配对二维码已生成。请在 App 的“远程访问”中扫描。', resetCpolarConfirm: '关闭 cpolar 远程通道并移除所有远程配对设备？不会修改你的 cpolar 账号或其他隧道。', resetTailscaleConfirm: '退出电脑上的 Tailscale 登录并移除所有远程配对设备？局域网配置不会改变。', requestFailed: '请求失败：{error}',
})

Object.assign(MOBILE_CONTROL_MESSAGES.en, {
  requestTimeout: 'The operation timed out. Confirm that DSH is still running, then try again.',
  diagnostics: 'Diagnostics', openDiagnostics: 'Open connection diagnostics', back: 'Back', backToMobile: 'Back to Mobile access', connectionDiagnostics: 'Connection diagnostics',
  diagnosticsIntro: 'Check versions, gateway, network adapter, firewall, and remote channel. The report is automatically redacted and never reads conversations or credentials.',
  diagnosticsNotRun: 'Not checked yet', diagnosticsStartHint: 'Select the button below to begin.', diagnosticsIdleMeta: 'Waiting to run · connection status only', diagnosticsStart: 'Start check', diagnosticsCopy: 'Copy redacted report', diagnosticsAdvanced: 'Advanced diagnostic details',
  diagnosticsComplete: 'Check complete', diagnosticsAttention: 'Some items need attention', diagnosticsProblem: 'Connection problems found', diagnosticsCompleteFallback: 'The check is complete.',
  diagnosticStatusOk: 'OK', diagnosticStatusWarning: 'Attention', diagnosticStatusError: 'Problem', diagnosticStatusInfo: 'Info', diagnosticItems: '{count} items', diagnosticCheck: 'Check', diagnosticAction: 'Suggested action',
  diagnosticNeedsAction: 'Needs action', diagnosticDetails: 'Check details', diagnosticOther: 'Other checks', diagnosticNoBlockers: '{count} checks · no blocking issues found', diagnosticNeedsCount: '{count} checks · {issues} need attention',
  diagnosticsChecking: 'Checking…', diagnosticsCheckingTitle: 'Checking connection', diagnosticsCheckingText: 'This usually takes a few seconds. The remote channel performs a real reachability test.', diagnosticsRunningMeta: 'Running · keep DSH online',
  diagnosticsIncomplete: 'Check not completed', diagnosticsReadFailed: 'Could not read diagnostics: {error}', diagnosticsUnavailable: 'Diagnostics service unavailable · try again later', diagnosticsRetry: 'Check again', diagnosticsCopied: 'Redacted report copied. You can paste it directly into an issue.', diagnosticsCopyManual: 'Clipboard access was denied. Details are expanded for manual copying.',
  diagnosticLabelVersions: 'Version compatibility', diagnosticLabelNetwork: 'Local network adapter', diagnosticLabelLan: 'Local network gateway', diagnosticLabelFirewall: 'Windows Firewall', diagnosticLabelRemote: 'Remote channel', diagnosticLabelPhone: 'Phone network',
  funnelTimeout: 'The Tailscale component timed out while starting. Check the network, then reconnect.',
})
Object.assign(MOBILE_CONTROL_MESSAGES.it, {
  requestTimeout: 'Operazione scaduta. Verifica che DSH sia ancora in esecuzione e riprova.',
  diagnostics: 'Diagnostica', openDiagnostics: 'Apri diagnostica connessione', back: 'Indietro', backToMobile: 'Torna ad Accesso mobile', connectionDiagnostics: 'Diagnostica connessione',
  diagnosticsIntro: 'Controlla versioni, gateway, scheda di rete, firewall e canale remoto. Il report viene anonimizzato automaticamente e non legge conversazioni o credenziali.',
  diagnosticsNotRun: 'Controllo non eseguito', diagnosticsStartHint: 'Premi il pulsante sotto per iniziare.', diagnosticsIdleMeta: 'In attesa · solo stato connessione', diagnosticsStart: 'Avvia controllo', diagnosticsCopy: 'Copia report anonimizzato', diagnosticsAdvanced: 'Dettagli diagnostici avanzati',
  diagnosticsComplete: 'Controllo completato', diagnosticsAttention: 'Alcuni elementi richiedono attenzione', diagnosticsProblem: 'Rilevati problemi di connessione', diagnosticsCompleteFallback: 'Controllo completato.',
  diagnosticStatusOk: 'OK', diagnosticStatusWarning: 'Attenzione', diagnosticStatusError: 'Problema', diagnosticStatusInfo: 'Informazione', diagnosticItems: '{count} elementi', diagnosticCheck: 'Controllo', diagnosticAction: 'Suggerimento',
  diagnosticNeedsAction: 'Da risolvere', diagnosticDetails: 'Dettagli controllo', diagnosticOther: 'Altri controlli', diagnosticNoBlockers: '{count} controlli · nessun problema bloccante', diagnosticNeedsCount: '{count} controlli · {issues} richiedono attenzione',
  diagnosticsChecking: 'Controllo…', diagnosticsCheckingTitle: 'Controllo connessione', diagnosticsCheckingText: 'Di solito richiede pochi secondi. Il canale remoto esegue un test reale di raggiungibilità.', diagnosticsRunningMeta: 'In esecuzione · mantieni DSH online',
  diagnosticsIncomplete: 'Controllo non completato', diagnosticsReadFailed: 'Impossibile leggere la diagnostica: {error}', diagnosticsUnavailable: 'Servizio diagnostico non disponibile · riprova più tardi', diagnosticsRetry: 'Ripeti controllo', diagnosticsCopied: 'Report anonimizzato copiato. Puoi incollarlo direttamente in una issue.', diagnosticsCopyManual: 'Il browser ha negato la copia. I dettagli sono stati aperti per la copia manuale.',
  diagnosticLabelVersions: 'Compatibilità versioni', diagnosticLabelNetwork: 'Scheda rete locale', diagnosticLabelLan: 'Gateway rete locale', diagnosticLabelFirewall: 'Windows Firewall', diagnosticLabelRemote: 'Canale remoto', diagnosticLabelPhone: 'Rete telefono',
  funnelTimeout: 'Avvio del componente Tailscale scaduto. Controlla la rete e riconnettiti.',
})
Object.assign(MOBILE_CONTROL_MESSAGES.zh, {
  requestTimeout: '操作超时，请确认 DSH 仍在运行后重试。',
  diagnostics: '诊断', openDiagnostics: '打开连接诊断', back: '返回', backToMobile: '返回移动访问', connectionDiagnostics: '连接诊断',
  diagnosticsIntro: '检查版本、网关、网卡、防火墙和远程通道。报告自动脱敏，不读取对话或凭据。', diagnosticsNotRun: '尚未检查', diagnosticsStartHint: '点击下方按钮开始。', diagnosticsIdleMeta: '等待运行 · 仅收集连接状态', diagnosticsStart: '开始检查', diagnosticsCopy: '复制脱敏报告', diagnosticsAdvanced: '高级诊断详情',
  diagnosticsComplete: '检查完成', diagnosticsAttention: '有项目需要留意', diagnosticsProblem: '发现连接问题', diagnosticsCompleteFallback: '检查已完成。', diagnosticStatusOk: '正常', diagnosticStatusWarning: '注意', diagnosticStatusError: '问题', diagnosticStatusInfo: '说明', diagnosticItems: '{count} 项', diagnosticCheck: '检查项', diagnosticAction: '建议', diagnosticNeedsAction: '需要处理', diagnosticDetails: '检查详情', diagnosticOther: '其他检查', diagnosticNoBlockers: '{count} 项检查 · 未发现阻断问题', diagnosticNeedsCount: '{count} 项检查 · {issues} 项需要处理',
  diagnosticsChecking: '正在检查…', diagnosticsCheckingTitle: '正在检查连接', diagnosticsCheckingText: '通常几秒内完成。远程通道会执行一次真实可达性测试。', diagnosticsRunningMeta: '正在运行 · 请保持 DSH 在线', diagnosticsIncomplete: '检查未完成', diagnosticsReadFailed: '无法读取诊断结果：{error}', diagnosticsUnavailable: '诊断服务暂不可用 · 请稍后重试', diagnosticsRetry: '重新检查', diagnosticsCopied: '脱敏报告已复制，可直接粘贴到 Issue。', diagnosticsCopyManual: '浏览器未允许复制，已展开详情，请手动复制。',
  diagnosticLabelVersions: '版本兼容', diagnosticLabelNetwork: '局域网网卡', diagnosticLabelLan: '局域网网关', diagnosticLabelFirewall: 'Windows 防火墙', diagnosticLabelRemote: '远程通道', diagnosticLabelPhone: '手机网络', funnelTimeout: 'Tailscale 组件启动超时，请检查网络后重新连接。',
})

export function selectMobileControlLocale(documentLanguage = '', navigatorLanguages: readonly string[] = [], preference = ''): MobileControlLocale {
  for (const value of [preference, documentLanguage, ...navigatorLanguages]) {
    const language = value.trim().toLowerCase().split(/[-_]/u)[0]
    if (language === 'it' || language === 'en' || language === 'zh') return language
  }
  return 'en'
}

export function selectedMobileControlLocale(): MobileControlLocale {
  let preference = ''
  try { preference = window.localStorage.getItem('dsh-mobile-control-locale') ?? '' } catch { /* Storage can be unavailable in hardened browser contexts. */ }
  return selectMobileControlLocale(document.documentElement.lang, navigator.languages?.length ? navigator.languages : [navigator.language], preference)
}

function controlTranslator(locale = selectedMobileControlLocale()): (key: string, values?: Readonly<Record<string, string | number>>) => string {
  const messages = MOBILE_CONTROL_MESSAGES as Record<MobileControlLocale, Record<string, string>>
  return (key, values = {}) => {
    const template = messages[locale][key] ?? messages.en[key] ?? key
    return template.replace(/\{(\w+)\}/gu, (_match: string, name: string) => String(values[name] ?? `{${name}}`))
  }
}

const LOCALIZED_DIAGNOSTIC_COPY = {
  en: {
    versions: 'Installed plugin, DSH, and minimum Android app versions are shown.',
    networkOk: 'The configured local network adapter is available.', networkError: 'The saved local network adapter is unavailable.', networkInfo: 'A fixed local network configuration is in use.', networkAction: 'Run dsh-mobile setup again.',
    lanOk: 'The local gateway is listening and pairing is available.', lanInfo: 'Local network access is currently off.', lanAction: 'Enable local network access when the phone must connect directly.',
    firewallOk: 'Local TCP and discovery firewall rules are enabled.', firewallWarning: 'The complete local network firewall rules were not found.', firewallInfo: 'The system did not allow the plugin to read firewall status.', firewallAction: 'Run dsh-mobile setup as administrator and check the firewall rules.',
    remoteOk: 'The remote public address passed the reachability check.', remoteWarning: 'The remote channel needs attention or is still connecting.', remoteError: 'The remote connection is not currently reachable.', remoteInfo: 'Remote access is currently off.', remoteAction: 'Return to Remote access, follow the provider guidance, and reconnect.',
    phone: 'The computer cannot determine whether the router isolates the phone.', phoneAction: 'Confirm the phone and computer use the same network, then disable guest-network or AP isolation.',
    reportTitle: 'DSH Mobile diagnostic report', generated: 'Generated',
  },
  it: {
    versions: 'Sono indicate le versioni installate di plugin e DSH e la versione minima dell’app Android.',
    networkOk: 'La scheda di rete locale configurata è disponibile.', networkError: 'La scheda di rete locale salvata non è disponibile.', networkInfo: 'È in uso una configurazione di rete locale fissa.', networkAction: 'Esegui di nuovo dsh-mobile setup.',
    lanOk: 'Il gateway locale è in ascolto e l’abbinamento è disponibile.', lanInfo: 'L’accesso dalla rete locale è disattivato.', lanAction: 'Attiva l’accesso locale quando il telefono deve collegarsi direttamente.',
    firewallOk: 'Le regole firewall TCP locale e di rilevamento sono attive.', firewallWarning: 'Le regole firewall complete per la rete locale non sono state trovate.', firewallInfo: 'Il sistema non ha consentito al plugin di leggere lo stato del firewall.', firewallAction: 'Esegui dsh-mobile setup come amministratore e controlla le regole firewall.',
    remoteOk: 'L’indirizzo pubblico remoto ha superato il test di raggiungibilità.', remoteWarning: 'Il canale remoto richiede attenzione o è ancora in connessione.', remoteError: 'La connessione remota non è al momento raggiungibile.', remoteInfo: 'L’accesso remoto è disattivato.', remoteAction: 'Torna ad Accesso remoto, segui le indicazioni del provider e riconnettiti.',
    phone: 'Il computer non può stabilire se il router isola il telefono.', phoneAction: 'Verifica che telefono e computer usino la stessa rete, poi disattiva rete ospiti o isolamento AP.',
    reportTitle: 'Report diagnostico DSH Mobile', generated: 'Generato',
  },
  zh: { reportTitle: 'DSH Mobile 诊断报告', generated: '生成时间' },
} as const

export const DIAGNOSTIC_REASON_MESSAGES = {
  en: {
    'versions-current': ['Installed plugin, DSH, and minimum Android app versions are shown.', ''],
    'network-unavailable': ['The saved local network adapter is unavailable.', 'Run dsh-mobile setup again.'],
    'network-interface': ['Using network interface {interfaceName}.', ''],
    'network-fixed': ['A fixed local network configuration is in use.', ''],
    'lan-ready': ['The local gateway is listening at {endpointSuffix}; pairing is available.', ''],
    'lan-off': ['Local network access is currently off.', 'Enable local network access when the phone must connect directly.'],
    'firewall-ready': ['Local TCP and discovery firewall rules are enabled.', ''],
    'firewall-missing': ['The complete local network firewall rules were not found.', 'Run dsh-mobile setup as administrator and check the firewall rules.'],
    'firewall-unknown': ['The system did not allow the plugin to read firewall status.', 'If the phone cannot find this computer, run setup as administrator.'],
    'remote-off': ['Remote access through {provider} is currently off.', ''],
    'remote-ready': ['{provider} endpoint {endpointSuffix} is reachable in about {latencyMs} ms.', ''],
    'remote-rate-limited': ['{provider} endpoint {endpointSuffix} is reachable, but this check observed rate limiting.', 'Try again later; older sessions load on demand to reduce traffic.'],
    'remote-fake-ip': ['The Tailscale address is intercepted by the current VPN or DNS proxy, so TLS was not established.', 'Switch VPN node or proxy mode; if it still fails, use cpolar.'],
    'remote-unreachable': ['{provider} reports ready, but endpoint {endpointSuffix} is not reachable.', 'Reconnect, then check the provider status if it still fails.'],
    'remote-needs-login': ['Tailscale is waiting for login to finish.', 'Return to Remote access and continue login.'],
    'remote-connecting': ['The {provider} remote channel is still connecting.', 'Wait briefly, then check again.'],
    'remote-controller-error': ['The {provider} controller reported {controllerCode}.', 'Return to Remote access and reconnect.'],
    'phone-network-unknown': ['The computer cannot determine whether the router isolates the phone.', 'Confirm the phone and computer use the same network, then disable guest-network or AP isolation.'],
  },
  it: {
    'versions-current': ['Sono indicate le versioni installate di plugin e DSH e la versione minima dell’app Android.', ''],
    'network-unavailable': ['La scheda di rete locale salvata non è disponibile.', 'Esegui di nuovo dsh-mobile setup.'],
    'network-interface': ['È in uso l’interfaccia di rete {interfaceName}.', ''],
    'network-fixed': ['È in uso una configurazione di rete locale fissa.', ''],
    'lan-ready': ['Il gateway locale è in ascolto su {endpointSuffix}; l’abbinamento è disponibile.', ''],
    'lan-off': ['L’accesso dalla rete locale è disattivato.', 'Attiva l’accesso locale quando il telefono deve collegarsi direttamente.'],
    'firewall-ready': ['Le regole firewall TCP locale e di rilevamento sono attive.', ''],
    'firewall-missing': ['Le regole firewall complete per la rete locale non sono state trovate.', 'Esegui dsh-mobile setup come amministratore e controlla le regole firewall.'],
    'firewall-unknown': ['Il sistema non ha consentito al plugin di leggere lo stato del firewall.', 'Se il telefono non trova il computer, esegui setup come amministratore.'],
    'remote-off': ['L’accesso remoto tramite {provider} è disattivato.', ''],
    'remote-ready': ['L’endpoint {provider} {endpointSuffix} è raggiungibile in circa {latencyMs} ms.', ''],
    'remote-rate-limited': ['L’endpoint {provider} {endpointSuffix} è raggiungibile, ma il controllo ha rilevato una limitazione temporanea.', 'Riprova più tardi; le sessioni precedenti vengono caricate su richiesta per ridurre il traffico.'],
    'remote-fake-ip': ['L’indirizzo Tailscale è intercettato dalla VPN o dal proxy DNS corrente e TLS non è stato stabilito.', 'Cambia nodo VPN o modalità proxy; se il problema continua, usa cpolar.'],
    'remote-unreachable': ['{provider} risulta pronto, ma l’endpoint {endpointSuffix} non è raggiungibile.', 'Riconnettiti; se il problema continua, controlla lo stato del provider.'],
    'remote-needs-login': ['Tailscale attende il completamento dell’accesso.', 'Torna ad Accesso remoto e continua l’accesso.'],
    'remote-connecting': ['Il canale remoto {provider} è ancora in connessione.', 'Attendi qualche istante e ripeti il controllo.'],
    'remote-controller-error': ['Il controller {provider} ha segnalato {controllerCode}.', 'Torna ad Accesso remoto e riconnettiti.'],
    'phone-network-unknown': ['Il computer non può stabilire se il router isola il telefono.', 'Verifica che telefono e computer usino la stessa rete, poi disattiva rete ospiti o isolamento AP.'],
  },
  zh: {
    'versions-current': ['已显示插件、DSH 和 Android App 最低版本。', ''],
    'network-unavailable': ['已保存的局域网网卡当前不可用。', '重新运行 dsh-mobile setup。'],
    'network-interface': ['正在使用网卡 {interfaceName}。', ''],
    'network-fixed': ['当前使用固定局域网配置。', ''],
    'lan-ready': ['局域网网关正在监听 {endpointSuffix}，配对入口可用。', ''],
    'lan-off': ['局域网访问当前未开启。', '手机需要直连时开启局域网访问。'],
    'firewall-ready': ['局域网 TCP 与发现防火墙规则已启用。', ''],
    'firewall-missing': ['未找到完整的局域网防火墙规则。', '以管理员身份运行 dsh-mobile setup 并检查防火墙规则。'],
    'firewall-unknown': ['系统未允许插件读取防火墙状态。', '若手机找不到电脑，请以管理员身份运行 setup。'],
    'remote-off': ['{provider} 远程访问当前未启用。', ''],
    'remote-ready': ['{provider} 端点 {endpointSuffix} 可达，往返约 {latencyMs} ms。', ''],
    'remote-rate-limited': ['{provider} 端点 {endpointSuffix} 可达，但本次检查观察到服务限流。', '稍后重试；旧会话会按需加载以减少流量。'],
    'remote-fake-ip': ['Tailscale 地址被当前 VPN 或 DNS 代理接管，TLS 链路未建立。', '切换 VPN 节点或代理模式；仍失败时改用 cpolar。'],
    'remote-unreachable': ['{provider} 显示已就绪，但端点 {endpointSuffix} 暂不可达。', '点击重新连接；仍失败时检查提供方状态。'],
    'remote-needs-login': ['Tailscale 正在等待完成登录。', '返回远程访问并继续登录。'],
    'remote-connecting': ['{provider} 远程通道仍在连接。', '等待片刻后重新检查。'],
    'remote-controller-error': ['{provider} 控制器报告 {controllerCode}。', '返回远程访问并重新连接。'],
    'phone-network-unknown': ['电脑无法判断路由器是否隔离了手机。', '确认手机与电脑使用同一网络，并关闭访客网络或 AP 隔离。'],
  },
} as const

export function normalizeDiagnosticOverall(value: unknown): 'ok' | 'attention' | 'error' {
  return value === 'ok' ? 'ok' : value === 'attention' ? 'attention' : 'error'
}

export function normalizeDiagnosticStatus(value: unknown): 'ok' | 'warning' | 'error' | 'info' {
  return value === 'ok' || value === 'warning' || value === 'error' || value === 'info' ? value : 'error'
}

export function diagnosticOverallForChecks(value: unknown, statuses: readonly unknown[]): 'ok' | 'attention' | 'error' {
  const normalized = statuses.map(normalizeDiagnosticStatus)
  const payloadOverall = normalizeDiagnosticOverall(value)
  if (payloadOverall === 'error' || normalized.includes('error')) return 'error'
  if (payloadOverall === 'attention' || normalized.includes('warning')) return 'attention'
  return 'ok'
}

export function validateDiagnosticChecks(value: unknown): { readonly entries: readonly Record<string, unknown>[]; readonly malformed: boolean } {
  if (!Array.isArray(value)) return { entries: [], malformed: true }
  const entries: Record<string, unknown>[] = []
  let malformed = false
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) { malformed = true; continue }
    entries.push(candidate as Record<string, unknown>)
  }
  return { entries, malformed }
}

export function diagnosticEntriesForRender(data: Readonly<Record<string, unknown>>): readonly Record<string, unknown>[] {
  const overallKnown = data.overall === 'ok' || data.overall === 'attention' || data.overall === 'error'
  const validated = validateDiagnosticChecks(data.checks)
  const statusesKnown = validated.entries.every(entry => entry.status === 'ok' || entry.status === 'warning' || entry.status === 'error' || entry.status === 'info')
  if (!overallKnown || validated.malformed || validated.entries.length === 0 || !statusesKnown) {
    throw new TypeError('diagnostics envelope is unavailable')
  }
  return validated.entries
}

export function renderDiagnosticPayloadSafely(
  data: Record<string, unknown>,
  render: (data: Record<string, unknown>) => void,
  onFailure: (error: unknown) => void,
): void {
  try { render(data) } catch (error) { onFailure(error) }
}

export function diagnosticServerCopy(entry: Readonly<Record<string, unknown>>): { readonly label: string; readonly detail: string; readonly action: string } {
  return {
    label: typeof entry.label === 'string' ? entry.label : '',
    detail: typeof entry.detail === 'string' ? entry.detail : '',
    action: typeof entry.action === 'string' ? entry.action : '',
  }
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

const CONTROL_REQUEST_TIMEOUT_MS = 15_000
const LONG_CONTROL_REQUEST_TIMEOUT_MS = 130_000

async function requestJson(
  path: string,
  init?: RequestInit,
  timeoutMs = CONTROL_REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const upstreamSignal = init?.signal
  const abortFromUpstream = (): void => { controller.abort(upstreamSignal?.reason) }
  if (upstreamSignal?.aborted === true) abortFromUpstream()
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true })
  const timer = window.setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...init?.headers },
    })
    const body = await response.json() as Record<string, unknown>
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${String(response.status)}`)
    return body
  } catch (error) {
    if (controller.signal.aborted && upstreamSignal?.aborted !== true) {
      throw new Error(controlTranslator()('requestTimeout'))
    }
    throw error
  } finally {
    clearTimeout(timer)
    upstreamSignal?.removeEventListener('abort', abortFromUpstream)
  }
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
  const locale = selectedMobileControlLocale()
  const localeTag = locale === 'it' ? 'it-IT' : locale === 'zh' ? 'zh-CN' : 'en-US'
  const t = controlTranslator(locale)
  const lifecycle = new AbortController()
  const controlRequestJson = (path: string, init?: RequestInit, timeoutMs?: number): Promise<Record<string, unknown>> => requestJson(path, { ...init, signal: lifecycle.signal }, timeoutMs)
  const root = element('div', 'dsh-mobile-control'); root.lang = locale
  const panel = element('section', 'dsh-mobile-control__panel'); panel.hidden = true; panel.lang = locale
  panel.setAttribute('aria-label', t('mobileAccess'))
  const header = element('header', 'dsh-mobile-control__header')
  const title = element('h2'); title.textContent = t('mobileAccess')
  const headerActions = element('div', 'dsh-mobile-control__header-actions')
  const diagnosticsEntry = element('button', 'dsh-mobile-control__diagnostic-entry'); diagnosticsEntry.type = 'button'; diagnosticsEntry.textContent = t('diagnostics'); diagnosticsEntry.setAttribute('aria-label', t('openDiagnostics')); diagnosticsEntry.setAttribute('aria-pressed', 'false')
  const close = element('button', 'dsh-mobile-control__close'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', t('collapseMobileAccess'))
  headerActions.append(diagnosticsEntry, close)
  const appDownload = element('a', 'dsh-mobile-control__app-download'); appDownload.href = 'https://github.com/saya-ch/dsh-mobile/releases/latest'; appDownload.target = '_blank'; appDownload.rel = 'noopener noreferrer'; appDownload.textContent = t('downloadAndroid'); appDownload.setAttribute('aria-label', t('downloadAndroidAria'))
  const switcher = element('div', 'dsh-mobile-control__switcher')
  const lanTab = element('button', 'dsh-mobile-control__tab is-active'); lanTab.type = 'button'; lanTab.textContent = t('lan')
  const remoteTab = element('button', 'dsh-mobile-control__tab'); remoteTab.type = 'button'; remoteTab.textContent = t('remote')
  lanTab.setAttribute('aria-pressed', 'true'); remoteTab.setAttribute('aria-pressed', 'false'); switcher.append(lanTab, remoteTab)
  const lanView = element('div', 'dsh-mobile-control__view')
  const access = element('div', 'dsh-mobile-control__access'); access.hidden = true
  const accessLabel = element('span', 'dsh-mobile-control__access-label'); accessLabel.textContent = t('browserAccess')
  const accessLink = element('a', 'dsh-mobile-control__access-link'); accessLink.target = '_blank'; accessLink.rel = 'noreferrer'
  access.append(accessLabel, accessLink)
  const qrBox = element('div', 'dsh-mobile-control__qr'); qrBox.hidden = true
  const status = element('p', 'dsh-mobile-control__status'); status.textContent = t('loadingStatus')
  const extensionStatus = element('p', 'dsh-mobile-control__extensions'); extensionStatus.hidden = true
  const actions = element('div', 'dsh-mobile-control__actions')
  const toggle = element('button', 'dsh-mobile-control__secondary'); toggle.type = 'button'
  const pair = element('button', 'dsh-mobile-control__primary'); pair.type = 'button'; pair.textContent = t('generateCopyKey')
  const linkPair = element('button', 'dsh-mobile-control__secondary'); linkPair.type = 'button'; linkPair.textContent = t('copyPairLink')
  const manageRow = element('div', 'dsh-mobile-control__manage-row')
  const manageDevices = element('button', 'dsh-mobile-control__manage'); manageDevices.type = 'button'; manageDevices.textContent = t('managePairedDevices')
  const resetAll = element('button', 'dsh-mobile-control__manage'); resetAll.type = 'button'; resetAll.textContent = t('clearAllDevices')
  manageRow.append(manageDevices, resetAll)
  const devicePanel = element('div', 'dsh-mobile-control__devices'); devicePanel.hidden = true
  const remoteView = element('div', 'dsh-mobile-control__view is-remote'); remoteView.hidden = true
  const remoteIntro = element('p', 'dsh-mobile-control__intro'); remoteIntro.textContent = t('remoteIntro')
  const providerSection = element('section', 'dsh-mobile-control__provider-section')
  const providerHeading = element('h3', 'dsh-mobile-control__section-title'); providerHeading.textContent = t('chooseProvider')
  const providerInfo = element('div', 'dsh-mobile-control__provider-info')
  const providerInfoButton = element('button', 'dsh-mobile-control__provider-info-button'); providerInfoButton.type = 'button'; providerInfoButton.setAttribute('aria-label', t('providerInfoAria')); providerInfoButton.setAttribute('aria-expanded', 'false'); providerInfoButton.setAttribute('aria-controls', 'dsh-mobile-provider-info'); providerInfoButton.setAttribute('aria-describedby', 'dsh-mobile-provider-info')
  const providerInfoGlyph = element('span', 'dsh-mobile-control__provider-info-glyph'); providerInfoGlyph.textContent = 'i'; providerInfoGlyph.setAttribute('aria-hidden', 'true')
  const providerInfoPopover = element('div', 'dsh-mobile-control__provider-info-popover'); providerInfoPopover.id = 'dsh-mobile-provider-info'; providerInfoPopover.setAttribute('role', 'tooltip'); providerInfoPopover.hidden = true
  const providerInfoTitle = element('strong'); providerInfoTitle.textContent = t('providerSafeTitle')
  const providerInfoText = element('span'); providerInfoText.textContent = t('providerSafeText')
  providerInfoButton.append(providerInfoGlyph); providerInfoPopover.append(providerInfoTitle, providerInfoText); providerInfo.append(providerInfoButton, providerInfoPopover)
  const providerChoices = element('div', 'dsh-mobile-control__provider-choices'); providerChoices.setAttribute('role', 'radiogroup'); providerChoices.setAttribute('aria-label', t('providerGroupAria'))
  const tailscaleChoice = element('button', 'dsh-mobile-control__provider'); tailscaleChoice.type = 'button'; tailscaleChoice.setAttribute('role', 'radio'); tailscaleChoice.setAttribute('aria-checked', 'true')
  const tailscaleChoiceTop = element('span', 'dsh-mobile-control__provider-top')
  const tailscaleChoiceName = element('strong'); tailscaleChoiceName.textContent = 'Tailscale Funnel'
  const tailscaleChoiceBadge = element('span', 'dsh-mobile-control__provider-badge'); tailscaleChoiceBadge.textContent = t('builtIn')
  const tailscaleChoiceDescription = element('span', 'dsh-mobile-control__provider-description'); tailscaleChoiceDescription.textContent = t('tailscaleDescription')
  tailscaleChoiceTop.append(tailscaleChoiceName, tailscaleChoiceBadge); tailscaleChoice.append(tailscaleChoiceTop, tailscaleChoiceDescription)
  const cpolarChoice = element('button', 'dsh-mobile-control__provider'); cpolarChoice.type = 'button'; cpolarChoice.setAttribute('role', 'radio'); cpolarChoice.setAttribute('aria-checked', 'false')
  const cpolarChoiceTop = element('span', 'dsh-mobile-control__provider-top')
  const cpolarChoiceName = element('strong'); cpolarChoiceName.textContent = 'cpolar'
  const cpolarChoiceBadge = element('span', 'dsh-mobile-control__provider-badge is-cpolar'); cpolarChoiceBadge.textContent = t('mainlandPreferred')
  const cpolarChoiceDescription = element('span', 'dsh-mobile-control__provider-description'); cpolarChoiceDescription.textContent = t('cpolarDescription')
  cpolarChoiceTop.append(cpolarChoiceName, cpolarChoiceBadge); cpolarChoice.append(cpolarChoiceTop, cpolarChoiceDescription)
  providerChoices.append(cpolarChoice, tailscaleChoice); providerSection.append(providerHeading, providerInfo, providerChoices)
  const cpolarSetup = element('section', 'dsh-mobile-control__cpolar-setup'); cpolarSetup.hidden = true
  const cpolarSetupTitle = element('h3', 'dsh-mobile-control__section-title'); cpolarSetupTitle.textContent = t('prepareCpolar')
  const cpolarComponentStatus = element('p', 'dsh-mobile-control__component-status'); cpolarComponentStatus.textContent = t('checkingComponent')
  const cpolarInstall = element('button', 'dsh-mobile-control__primary'); cpolarInstall.type = 'button'; cpolarInstall.textContent = t('installOfficial')
  const cpolarAccount = element('div', 'dsh-mobile-control__cpolar-account'); cpolarAccount.hidden = true
  const cpolarAccountText = element('p', 'dsh-mobile-control__component-note'); cpolarAccountText.textContent = t('cpolarAccountNote')
  const cpolarAccountLinks = element('div', 'dsh-mobile-control__link-row')
  const cpolarSignup = element('a', 'dsh-mobile-control__text-link'); cpolarSignup.href = 'https://dashboard.cpolar.com/signup'; cpolarSignup.target = '_blank'; cpolarSignup.rel = 'noopener noreferrer'; cpolarSignup.textContent = t('registerCpolar')
  const cpolarDashboard = element('a', 'dsh-mobile-control__text-link'); cpolarDashboard.href = 'https://dashboard.cpolar.com/auth'; cpolarDashboard.target = '_blank'; cpolarDashboard.rel = 'noopener noreferrer'; cpolarDashboard.textContent = t('openDashboard')
  cpolarAccountLinks.append(cpolarSignup, cpolarDashboard)
  const cpolarTokenLabel = element('label', 'dsh-mobile-control__token-label'); cpolarTokenLabel.textContent = 'Authtoken'
  const cpolarToken = element('input', 'dsh-mobile-control__token'); cpolarToken.type = 'password'; cpolarToken.autocomplete = 'off'; cpolarToken.spellcheck = false; cpolarToken.placeholder = t('tokenPlaceholder'); cpolarTokenLabel.append(cpolarToken)
  const cpolarConfigure = element('button', 'dsh-mobile-control__primary dsh-mobile-control__cpolar-connect'); cpolarConfigure.type = 'button'; cpolarConfigure.textContent = t('saveConnect')
  cpolarAccount.append(cpolarAccountText, cpolarAccountLinks, cpolarTokenLabel, cpolarConfigure)
  const cpolarDetails = element('details', 'dsh-mobile-control__details')
  const cpolarDetailsSummary = element('summary'); cpolarDetailsSummary.textContent = t('componentDetails')
  const cpolarDetailsBody = element('div', 'dsh-mobile-control__details-body')
  const cpolarDetailsText = element('p'); cpolarDetailsText.textContent = t('componentDetailsText')
  const cpolarStorage = element('code', 'dsh-mobile-control__storage'); cpolarStorage.textContent = t('pluginPrivateDirectory')
  const cpolarOfficial = element('a', 'dsh-mobile-control__text-link'); cpolarOfficial.href = 'https://www.cpolar.com/download'; cpolarOfficial.target = '_blank'; cpolarOfficial.rel = 'noopener noreferrer'; cpolarOfficial.textContent = t('officialDownload')
  const cpolarTerms = element('a', 'dsh-mobile-control__text-link'); cpolarTerms.href = 'https://www.cpolar.com/tos'; cpolarTerms.target = '_blank'; cpolarTerms.rel = 'noopener noreferrer'; cpolarTerms.textContent = t('terms')
  const cpolarPurge = element('button', 'dsh-mobile-control__danger'); cpolarPurge.type = 'button'; cpolarPurge.textContent = t('purgeCpolar')
  cpolarDetailsBody.append(cpolarDetailsText, cpolarStorage, cpolarOfficial, cpolarTerms, cpolarPurge); cpolarDetails.append(cpolarDetailsSummary, cpolarDetailsBody)
  cpolarSetup.append(cpolarSetupTitle, cpolarComponentStatus, cpolarInstall, cpolarAccount, cpolarDetails)
  const tailscaleInfo = element('details', 'dsh-mobile-control__details')
  const tailscaleInfoSummary = element('summary'); tailscaleInfoSummary.textContent = t('tailscaleHelp')
  const tailscaleInfoBody = element('div', 'dsh-mobile-control__details-body')
  const tailscaleInfoText = element('p'); tailscaleInfoText.textContent = t('tailscaleHelpText')
  tailscaleInfoBody.append(tailscaleInfoText); tailscaleInfo.append(tailscaleInfoSummary, tailscaleInfoBody)
  const remoteAccess = element('div', 'dsh-mobile-control__access'); remoteAccess.hidden = true
  const remoteAccessLabel = element('span', 'dsh-mobile-control__access-label'); remoteAccessLabel.textContent = t('remoteAddress')
  const remoteAccessLink = element('a', 'dsh-mobile-control__access-link'); remoteAccessLink.target = '_blank'; remoteAccessLink.rel = 'noreferrer'; remoteAccess.append(remoteAccessLabel, remoteAccessLink)
  const remoteQr = element('div', 'dsh-mobile-control__qr'); remoteQr.hidden = true
  const remoteStatus = element('p', 'dsh-mobile-control__status'); remoteStatus.textContent = t('loadingRemoteStatus'); remoteStatus.setAttribute('aria-live', 'polite')
  const remoteGuide = element('section', 'dsh-mobile-control__guide'); remoteGuide.hidden = true; remoteGuide.setAttribute('aria-label', t('funnelGuideAria'))
  const remoteGuideTitle = element('h3', 'dsh-mobile-control__guide-title'); remoteGuideTitle.textContent = t('funnelGuideTitle')
  const remoteGuideSummary = element('p', 'dsh-mobile-control__guide-summary'); remoteGuideSummary.textContent = t('funnelGuideSummary')
  const remoteGuideSteps = element('ol', 'dsh-mobile-control__guide-steps')
  for (const text of [t('funnelStep1'), t('funnelStep2'), t('funnelStep3')]) {
    const item = element('li'); item.textContent = text; remoteGuideSteps.append(item)
  }
  const remoteGuideNote = element('p', 'dsh-mobile-control__guide-note'); remoteGuideNote.textContent = t('funnelGuideNote')
  const remoteGuideActions = element('div', 'dsh-mobile-control__guide-actions')
  const remoteSetup = element('button', 'dsh-mobile-control__primary'); remoteSetup.type = 'button'; remoteSetup.textContent = t('continueFunnel')
  const remoteSetupRetry = element('button', 'dsh-mobile-control__secondary'); remoteSetupRetry.type = 'button'; remoteSetupRetry.textContent = t('retryNow')
  remoteGuideActions.append(remoteSetup, remoteSetupRetry); remoteGuide.append(remoteGuideTitle, remoteGuideSummary, remoteGuideSteps, remoteGuideNote, remoteGuideActions)
  const remoteActions = element('div', 'dsh-mobile-control__actions')
  const remoteToggle = element('button', 'dsh-mobile-control__primary'); remoteToggle.type = 'button'; remoteToggle.textContent = t('enableRemote')
  const remoteLogin = element('button', 'dsh-mobile-control__primary'); remoteLogin.type = 'button'; remoteLogin.textContent = t('continueLogin'); remoteLogin.hidden = true
  const remoteReconnect = element('button', 'dsh-mobile-control__secondary'); remoteReconnect.type = 'button'; remoteReconnect.textContent = t('reconnect'); remoteReconnect.hidden = true
  const remotePair = element('button', 'dsh-mobile-control__secondary'); remotePair.type = 'button'; remotePair.textContent = t('generateRemoteQr'); remotePair.disabled = true
  remoteActions.append(remoteToggle, remoteLogin, remoteReconnect, remotePair)
  const remoteManageRow = element('div', 'dsh-mobile-control__manage-row')
  const remoteDevices = element('button', 'dsh-mobile-control__manage'); remoteDevices.type = 'button'; remoteDevices.textContent = t('manageRemoteDevices'); remoteDevices.disabled = true
  const remoteReset = element('button', 'dsh-mobile-control__manage'); remoteReset.type = 'button'; remoteReset.textContent = t('resetRemoteLogin')
  remoteManageRow.append(remoteDevices, remoteReset)
  const remoteDevicePanel = element('div', 'dsh-mobile-control__devices'); remoteDevicePanel.hidden = true
  const diagnosticsView = element('div', 'dsh-mobile-control__view is-diagnostics'); diagnosticsView.hidden = true
  const diagnosticsIntro = element('p', 'dsh-mobile-control__intro'); diagnosticsIntro.textContent = t('diagnosticsIntro')
  const diagnosticsSummary = element('section', 'dsh-mobile-control__diagnostic-summary is-idle'); diagnosticsSummary.setAttribute('aria-live', 'polite')
  const diagnosticsSummaryMain = element('div', 'dsh-mobile-control__diagnostic-summary-main')
  const diagnosticsSummaryIcon = element('span', 'dsh-mobile-control__diagnostic-summary-icon'); diagnosticsSummaryIcon.setAttribute('aria-hidden', 'true')
  const diagnosticsSummaryBody = element('div', 'dsh-mobile-control__diagnostic-summary-body')
  const diagnosticsSummaryTitle = element('strong'); diagnosticsSummaryTitle.textContent = t('diagnosticsNotRun')
  const diagnosticsSummaryText = element('span'); diagnosticsSummaryText.textContent = t('diagnosticsStartHint')
  const diagnosticsSummaryMeta = element('span', 'dsh-mobile-control__diagnostic-summary-meta'); diagnosticsSummaryMeta.textContent = t('diagnosticsIdleMeta')
  diagnosticsSummaryBody.append(diagnosticsSummaryTitle, diagnosticsSummaryText)
  diagnosticsSummaryMain.append(diagnosticsSummaryIcon, diagnosticsSummaryBody)
  diagnosticsSummary.append(diagnosticsSummaryMain, diagnosticsSummaryMeta)
  const diagnosticsToolbar = element('div', 'dsh-mobile-control__diagnostic-toolbar')
  const diagnosticsRun = element('button', 'dsh-mobile-control__primary dsh-mobile-control__diagnostic-run'); diagnosticsRun.type = 'button'; diagnosticsRun.textContent = t('diagnosticsStart')
  const diagnosticsCopy = element('button', 'dsh-mobile-control__secondary dsh-mobile-control__diagnostic-copy'); diagnosticsCopy.type = 'button'; diagnosticsCopy.textContent = t('diagnosticsCopy'); diagnosticsCopy.disabled = true; diagnosticsCopy.hidden = true
  diagnosticsToolbar.append(diagnosticsRun, diagnosticsCopy)
  const diagnosticsFeedback = element('p', 'dsh-mobile-control__diagnostic-feedback'); diagnosticsFeedback.hidden = true; diagnosticsFeedback.setAttribute('role', 'status'); diagnosticsFeedback.setAttribute('aria-live', 'polite')
  const diagnosticsChecks = element('div', 'dsh-mobile-control__diagnostic-checks'); diagnosticsChecks.hidden = true
  const diagnosticsDetails = element('details', 'dsh-mobile-control__details dsh-mobile-control__diagnostic-details'); diagnosticsDetails.hidden = true
  const diagnosticsDetailsSummary = element('summary'); diagnosticsDetailsSummary.textContent = t('diagnosticsAdvanced')
  const diagnosticsReport = element('pre', 'dsh-mobile-control__diagnostic-report')
  diagnosticsDetails.append(diagnosticsDetailsSummary, diagnosticsReport)
  header.append(title, headerActions); actions.append(toggle, pair, linkPair)
  lanView.append(access, qrBox, status, extensionStatus, actions, manageRow, devicePanel)
  remoteView.append(remoteIntro, providerSection, cpolarSetup, tailscaleInfo, remoteAccess, remoteQr, remoteStatus, remoteGuide, remoteActions, remoteManageRow, remoteDevicePanel)
  diagnosticsView.append(diagnosticsIntro, diagnosticsSummary, diagnosticsToolbar, diagnosticsFeedback, diagnosticsChecks, diagnosticsDetails)
  panel.append(header, appDownload, switcher, lanView, remoteView, diagnosticsView); root.append(panel); document.body.append(root)
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
  let previousAccessView: 'lan' | 'remote' = 'lan'
  let diagnosticsBusy = false
  let copiedDiagnosticReport = ''
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
  const selectView = (view: 'lan' | 'remote' | 'diagnostics'): void => {
    if (view !== 'diagnostics') previousAccessView = view
    lanView.hidden = view !== 'lan'
    remoteView.hidden = view !== 'remote'
    diagnosticsView.hidden = view !== 'diagnostics'
    lanTab.classList.toggle('is-active', view === 'lan')
    remoteTab.classList.toggle('is-active', view === 'remote')
    lanTab.setAttribute('aria-pressed', String(view === 'lan'))
    remoteTab.setAttribute('aria-pressed', String(view === 'remote'))
    diagnosticsEntry.setAttribute('aria-pressed', String(view === 'diagnostics'))
    diagnosticsEntry.textContent = view === 'diagnostics' ? t('back') : t('diagnostics')
    diagnosticsEntry.setAttribute('aria-label', view === 'diagnostics' ? t('backToMobile') : t('openDiagnostics'))
    appDownload.hidden = view === 'diagnostics'
    switcher.hidden = view === 'diagnostics'
    title.textContent = view === 'lan' ? t('lanAccess') : view === 'remote' ? t('remoteAccess') : t('connectionDiagnostics')
  }
  lanTab.addEventListener('click', () => { selectView('lan') })
  remoteTab.addEventListener('click', () => { selectView('remote'); loadRemote() })
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
    status.textContent = running ? t('lanOn') : t('lanOff')
    const extensionData = data.extensions
    if (extensionData !== null && typeof extensionData === 'object') {
      const loaded = typeof (extensionData as { loaded?: unknown }).loaded === 'number' ? (extensionData as { loaded: number }).loaded : 0
      const failed = typeof (extensionData as { failed?: unknown }).failed === 'number' ? (extensionData as { failed: number }).failed : 0
      extensionStatus.hidden = false
      extensionStatus.textContent = failed === 0 ? t('extensionsLoaded', { loaded }) : t('extensionsFailed', { loaded, failed })
    } else extensionStatus.hidden = true
    if (!running) qrBox.hidden = true
    toggle.textContent = running ? t('disableLan') : t('enableLan')
    pair.disabled = !running
    linkPair.disabled = !running
    manageDevices.disabled = !running
    resetAll.disabled = !running
  }
  const showQr = (svg: string, target: HTMLDivElement = qrBox): void => {
    target.replaceChildren()
    if (svg === '') { target.hidden = true; return }
    const image = element('img')
    image.alt = t('pairingQr')
    image.width = 176
    image.height = 176
    image.src = `data:image/svg+xml;base64,${btoa(svg)}`
    target.hidden = false
    target.append(image)
  }
  const openPairing = (target: 'key' | 'link'): void => {
    void controlRequestJson('/api/mobile-access/lan/pairing/open', { method: 'POST', body: '{}' }).then(async data => {
      const value = target === 'key'
        ? (typeof data.appKey === 'string' ? data.appKey : '')
        : (typeof data.pairUrl === 'string' ? data.pairUrl : '')
      showQr(typeof data.qrSvg === 'string' ? data.qrSvg : '')
      if (value === '') { status.textContent = t('keyGenerationFailed'); return }
      try {
        await navigator.clipboard.writeText(value)
        status.textContent = target === 'key'
          ? t('keyCopied')
          : t('linkCopied')
      } catch {
        status.textContent = t('copySecret', { kind: target === 'key' ? t('pairingKey') : t('pairingLink'), value })
        status.classList.add('is-key')
      }
    }, error => { status.textContent = t('requestFailed', { error: String(error) }) }).finally(() => {
      pair.disabled = !running
      linkPair.disabled = !running
    })
  }
  toggle.addEventListener('click', () => { toggle.disabled = true; void controlRequestJson('/api/mobile-access/lan/control', { method: 'POST', body: JSON.stringify({ running: !running }) }).then(render, error => { status.textContent = t('requestFailed', { error: String(error) }) }).finally(() => { toggle.disabled = false }) })
  const formatTime = (ms: unknown): string => typeof ms === 'number' ? new Date(ms).toLocaleString(localeTag) : ''
  const formatMegabytes = (bytes: number): string => new Intl.NumberFormat(localeTag, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)
  const renderDevices = (data: Record<string, unknown>): void => {
    const devices = Array.isArray(data.devices) ? data.devices as Record<string, unknown>[] : []
    devicePanel.replaceChildren()
    if (devices.length === 0) {
      const empty = element('p', 'dsh-mobile-control__device-empty'); empty.textContent = t('noDevices')
      devicePanel.append(empty)
      return
    }
    for (const device of devices) {
      const row = element('div', 'dsh-mobile-control__device')
      const label = element('span', 'dsh-mobile-control__device-label')
      label.textContent = typeof device.label === 'string' ? device.label : t('device')
      const meta = element('span', 'dsh-mobile-control__device-meta'); meta.textContent = t('expires', { time: formatTime(device.expiresAt) })
      const revoke = element('button', 'dsh-mobile-control__device-revoke'); revoke.type = 'button'; revoke.textContent = t('revoke')
      const id = typeof device.id === 'string' ? device.id : ''
      revoke.addEventListener('click', () => {
        void controlRequestJson('/api/mobile-access/lan/devices/revoke', { method: 'POST', body: JSON.stringify({ deviceId: id }) })
          .then(loadDevices, error => { status.textContent = t('requestFailed', { error: String(error) }) })
      })
      row.append(label, meta, revoke)
      devicePanel.append(row)
    }
  }
  const loadDevices = (): void => {
    void controlRequestJson('/api/mobile-access/lan/devices').then(renderDevices, error => { status.textContent = t('requestFailed', { error: String(error) }) })
  }
  manageDevices.addEventListener('click', () => {
    const show = devicePanel.hidden
    devicePanel.hidden = !show
    if (show) loadDevices()
  })
  resetAll.addEventListener('click', () => {
    if (!window.confirm(t('confirmResetDevices'))) return
    void controlRequestJson('/api/mobile-access/lan/devices/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      .then(loadDevices, error => { status.textContent = t('requestFailed', { error: String(error) }) })
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
    remoteReset.textContent = cpolar ? t('resetRemoteDevices') : t('resetRemoteLogin')
    const providers = data.providers !== null && typeof data.providers === 'object' ? data.providers as Record<string, unknown> : {}
    const cpolarProvider = providers.cpolar !== null && typeof providers.cpolar === 'object' ? providers.cpolar as Record<string, unknown> : {}
    const component = cpolarProvider.component !== null && typeof cpolarProvider.component === 'object'
      ? cpolarProvider.component as Record<string, unknown>
      : {}
    cpolarInstalled = component.installed === true
    cpolarConfigured = component.configured === true
    cpolarChoiceBadge.textContent = cpolarConfigured ? t('ready') : cpolarInstalled ? t('installed') : t('mainlandPreferred')
    const cpolarSupported = component.supported !== false
    const componentVersion = typeof component.version === 'string' ? component.version : ''
    const componentDownloadBytes = typeof component.downloadBytes === 'number' ? component.downloadBytes : 0
    const componentStorage = typeof component.storagePath === 'string' ? component.storagePath : `DSH Mobile ${t('pluginPrivateDirectory')}`
    cpolarStorage.textContent = componentStorage
    cpolarStorage.title = componentStorage
    cpolarInstall.hidden = cpolarInstalled || !cpolarSupported
    cpolarInstall.textContent = componentDownloadBytes > 0
      ? t('installWithSize', { size: formatMegabytes(componentDownloadBytes) })
      : t('installOfficial')
    cpolarInstall.disabled = remoteProviderBusy
    cpolarAccount.hidden = !cpolarInstalled || cpolarConfigured
    cpolarConfigure.disabled = remoteProviderBusy
    cpolarPurge.hidden = !cpolarInstalled && !cpolarConfigured
    cpolarComponentStatus.textContent = !cpolarSupported
      ? t('cpolarUnsupported')
      : !cpolarInstalled
        ? t('cpolarNotInstalled')
        : !cpolarConfigured
          ? t('cpolarNeedsToken', { version: componentVersion })
          : t('cpolarReady', { version: componentVersion })
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
      off: t('remoteOff'),
      unavailable: cpolar ? t('remoteUnavailableCpolar') : t('remoteUnavailableTailscale'),
      starting: cpolar ? t('remoteStartingCpolar') : t('remoteStartingTailscale'),
      'needs-login': t('remoteNeedsLogin'),
      connecting: cpolar ? t('remoteConnectingCpolar') : t('remoteConnectingTailscale'),
      ready: t('remoteReady'),
      error: t('remoteError'),
    }
    const errorLabels: Record<string, string> = {
      funnel_permission_required: t('funnelPermission'),
      funnel_https_required: t('funnelHttps'),
      funnel_start_failed: t('funnelStart'),
      funnel_start_timeout: t('funnelTimeout'),
      tailscale_dns_missing: t('tailscaleDnsMissing'),
      gateway_start_failed: t('gatewayStartFailed'),
      control_channel_failed: t('controlChannelFailed'),
      cpolar_component_missing: t('cpolarMissing'),
      cpolar_component_invalid: t('cpolarInvalid'),
      cpolar_config_missing: t('cpolarConfigMissing'),
      cpolar_config_invalid: t('cpolarConfigInvalid'),
      cpolar_port_unavailable: t('cpolarPortUnavailable'),
      cpolar_launch_failed: t('cpolarLaunchFailed'),
      cpolar_start_timeout: t('cpolarTimeout'),
      cpolar_stopped: t('cpolarStopped'),
      cpolar_exited: t('cpolarExited'),
      cpolar_invalid_output: t('cpolarOutputInvalid'),
      cpolar_invalid_origin: t('cpolarOriginInvalid'),
    }
    remoteStatus.textContent = remoteSetupPending && needsFunnelSetup
      ? t('setupOpened')
      : (state === 'error' ? (errorLabels[errorCode] ?? labels.error!) : (labels[state] ?? labels.error!))
    remoteGuide.hidden = !needsFunnelSetup
    remoteSetup.disabled = remoteSetupUrl === '' || remoteReconnectBusy
    remoteSetupRetry.disabled = remoteReconnectBusy
    remoteToggle.textContent = remoteRunning ? t('disableRemote') : t('enableRemote')
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
  let remoteLoadInFlight = false
  const loadRemote = (): void => {
    if (remoteLoadInFlight) return
    remoteLoadInFlight = true
    void controlRequestJson('/api/mobile-access/remote/control')
      .then(renderRemote, error => { remoteStatus.textContent = t('requestFailed', { error: String(error) }) })
      .finally(() => { remoteLoadInFlight = false })
  }
  const chooseRemoteProvider = (provider: 'tailscale' | 'cpolar'): void => {
    if (remoteProviderBusy || provider === remoteProvider) return
    if (remoteRunning && !window.confirm(t('switchProviderConfirm'))) return
    remoteProviderBusy = true
    tailscaleChoice.disabled = true
    cpolarChoice.disabled = true
    remoteStatus.textContent = provider === 'cpolar' ? t('switchingCpolar') : t('switchingTailscale')
    void controlRequestJson('/api/mobile-access/remote/provider', { method: 'POST', body: JSON.stringify({ provider }) })
      .then(renderRemote, error => { remoteStatus.textContent = t('requestFailed', { error: String(error) }) })
      .finally(() => { remoteProviderBusy = false; loadRemote() })
  }
  tailscaleChoice.addEventListener('click', () => { chooseRemoteProvider('tailscale') })
  cpolarChoice.addEventListener('click', () => { chooseRemoteProvider('cpolar') })
  cpolarInstall.addEventListener('click', () => {
    if (remoteProviderBusy) return
    const accepted = window.confirm(t('installConfirm'))
    if (!accepted) return
    remoteProviderBusy = true
    cpolarInstall.disabled = true
    cpolarInstall.textContent = t('downloading')
    remoteStatus.textContent = t('installingCpolar')
    void controlRequestJson('/api/mobile-access/remote/cpolar/component/install', { method: 'POST', body: JSON.stringify({ confirm: true }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(renderRemote, error => { remoteStatus.textContent = t('installFailed', { error: String(error) }) })
      .finally(() => { remoteProviderBusy = false; loadRemote() })
  })
  cpolarConfigure.addEventListener('click', () => {
    if (remoteProviderBusy) return
    const authtoken = cpolarToken.value.trim()
    if (authtoken.length < 20 || /\s/u.test(authtoken)) {
      remoteStatus.textContent = t('invalidToken')
      cpolarToken.focus()
      return
    }
    remoteProviderBusy = true
    cpolarConfigure.disabled = true
    cpolarConfigure.setAttribute('aria-busy', 'true')
    cpolarConfigure.textContent = t('saving')
    void controlRequestJson('/api/mobile-access/remote/cpolar/configure', { method: 'POST', body: JSON.stringify({ authtoken }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(() => {
        cpolarToken.value = ''
        remoteStatus.textContent = t('configuredConnecting')
        return controlRequestJson('/api/mobile-access/remote/control', { method: 'POST', body: JSON.stringify({ running: true }) })
      })
      .then(renderRemote, error => { remoteStatus.textContent = t('configureFailed', { error: String(error) }) })
      .finally(() => { remoteProviderBusy = false; cpolarConfigure.setAttribute('aria-busy', 'false'); cpolarConfigure.textContent = t('saveConnect'); loadRemote() })
  })
  cpolarPurge.addEventListener('click', () => {
    if (remoteProviderBusy) return
    if (!window.confirm(t('purgeConfirm'))) return
    remoteProviderBusy = true
    cpolarPurge.disabled = true
    remoteStatus.textContent = t('purging')
    void controlRequestJson('/api/mobile-access/remote/cpolar/component/purge', { method: 'POST', body: JSON.stringify({ confirm: true }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(renderRemote, error => { remoteStatus.textContent = t('purgeFailed', { error: String(error) }) })
      .finally(() => { remoteProviderBusy = false; cpolarPurge.disabled = false; loadRemote() })
  })
  remoteToggle.addEventListener('click', () => {
    remoteToggle.disabled = true
    void controlRequestJson('/api/mobile-access/remote/control', { method: 'POST', body: JSON.stringify({ running: !remoteRunning }) })
      .then(renderRemote, error => { remoteStatus.textContent = t('requestFailed', { error: String(error) }) })
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
    remoteStatus.textContent = remoteProvider === 'cpolar' ? t('reconnectingCpolar') : t('reconnectingTailscale')
    void controlRequestJson('/api/mobile-access/remote/reconnect', { method: 'POST', body: '{}' })
      .then(renderRemote, error => { remoteStatus.textContent = t('requestFailed', { error: String(error) }) })
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
    remoteStatus.textContent = t('setupOpened')
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
    void controlRequestJson('/api/mobile-access/remote/pairing/open', { method: 'POST', body: '{}' }).then(async data => {
      const pairUrl = typeof data.pairUrl === 'string' ? data.pairUrl : ''
      showQr(typeof data.qrSvg === 'string' ? data.qrSvg : '', remoteQr)
      if (pairUrl !== '') {
        try { await navigator.clipboard.writeText(pairUrl) } catch { /* QR remains the primary remote handoff. */ }
      }
      remoteStatus.textContent = t('remoteQrReady')
    }, error => { remoteStatus.textContent = t('requestFailed', { error: String(error) }) }).finally(() => { remotePair.disabled = !remoteReady })
  })
  const renderRemoteDevices = (data: Record<string, unknown>): void => {
    const devices = Array.isArray(data.devices) ? data.devices as Record<string, unknown>[] : []
    remoteDevicePanel.replaceChildren()
    if (devices.length === 0) {
      const empty = element('p', 'dsh-mobile-control__device-empty'); empty.textContent = t('noRemoteDevices'); remoteDevicePanel.append(empty); return
    }
    for (const device of devices) {
      const row = element('div', 'dsh-mobile-control__device')
      const label = element('span', 'dsh-mobile-control__device-label'); label.textContent = typeof device.label === 'string' ? device.label : t('device')
      const meta = element('span', 'dsh-mobile-control__device-meta'); meta.textContent = t('expires', { time: formatTime(device.expiresAt) })
      const revoke = element('button', 'dsh-mobile-control__device-revoke'); revoke.type = 'button'; revoke.textContent = t('revoke')
      const id = typeof device.id === 'string' ? device.id : ''
      revoke.addEventListener('click', () => {
        void controlRequestJson('/api/mobile-access/remote/devices/revoke', { method: 'POST', body: JSON.stringify({ deviceId: id }) })
          .then(loadRemoteDevices, error => { remoteStatus.textContent = t('requestFailed', { error: String(error) }) })
      })
      row.append(label, meta, revoke); remoteDevicePanel.append(row)
    }
  }
  const loadRemoteDevices = (): void => {
    void controlRequestJson('/api/mobile-access/remote/devices').then(renderRemoteDevices, error => { remoteStatus.textContent = t('requestFailed', { error: String(error) }) })
  }
  remoteDevices.addEventListener('click', () => {
    const show = remoteDevicePanel.hidden
    remoteDevicePanel.hidden = !show
    if (show) loadRemoteDevices()
  })
  remoteReset.addEventListener('click', () => {
    const prompt = remoteProvider === 'cpolar'
      ? t('resetCpolarConfirm')
      : t('resetTailscaleConfirm')
    if (!window.confirm(prompt)) return
    void controlRequestJson('/api/mobile-access/remote/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      .then(renderRemote, error => { remoteStatus.textContent = t('requestFailed', { error: String(error) }) })
  })
  const renderDiagnostics = (data: Record<string, unknown>): void => {
    const entries = [...diagnosticEntriesForRender(data)]
    const overall = diagnosticOverallForChecks(data.overall, entries.map(entry => entry.status))
    diagnosticsSummary.className = `dsh-mobile-control__diagnostic-summary is-${overall}`
    diagnosticsSummaryTitle.textContent = overall === 'ok' ? t('diagnosticsComplete') : overall === 'attention' ? t('diagnosticsAttention') : t('diagnosticsProblem')
    diagnosticsSummaryText.textContent = locale === 'zh' && data.overall === overall && typeof data.summary === 'string' ? data.summary : t('diagnosticsCompleteFallback')
    diagnosticsChecks.replaceChildren()
    const statusLabels: Record<string, string> = { ok: t('diagnosticStatusOk'), warning: t('diagnosticStatusWarning'), error: t('diagnosticStatusError'), info: t('diagnosticStatusInfo') }
    const diagnosticLabelKeys: Record<string, string> = {
      versions: 'diagnosticLabelVersions', network: 'diagnosticLabelNetwork', lan: 'diagnosticLabelLan',
      firewall: 'diagnosticLabelFirewall', remote: 'diagnosticLabelRemote', 'phone-network': 'diagnosticLabelPhone',
    }
    const statusOf = (entry: Record<string, unknown>): 'ok' | 'warning' | 'error' | 'info' => normalizeDiagnosticStatus(entry.status)
    const localizedEntryCopy = (entry: Record<string, unknown>): { readonly detail: string; readonly action: string } => {
      const serverCopy = diagnosticServerCopy(entry)
      const reason = typeof entry.reason === 'string' ? entry.reason : ''
      const catalog = DIAGNOSTIC_REASON_MESSAGES[locale] as Readonly<Record<string, readonly [string, string]>>
      const templates = catalog[reason]
      if (templates === undefined) return serverCopy
      const facts = entry.facts !== null && typeof entry.facts === 'object' ? entry.facts as Record<string, unknown> : {}
      const values: Record<string, string> = {
        provider: facts.provider === 'tailscale' || facts.provider === 'cpolar' ? facts.provider : '',
        latencyMs: typeof facts.latencyMs === 'number' && Number.isFinite(facts.latencyMs) ? new Intl.NumberFormat(localeTag).format(facts.latencyMs) : '',
        interfaceName: typeof facts.interfaceName === 'string' ? facts.interfaceName : '',
        endpointSuffix: typeof facts.endpointSuffix === 'string' ? facts.endpointSuffix : '',
        controllerCode: typeof facts.controllerCode === 'string' ? facts.controllerCode : '',
      }
      const interpolate = (template: string): string => template.replace(/\{(\w+)\}/gu, (_match, key: string) => values[key] ?? '')
      let detail = interpolate(templates[0])
      let action = interpolate(templates[1])
      if (reason === 'versions-current') {
        const versions = data.versions !== null && typeof data.versions === 'object' ? data.versions as Record<string, unknown> : {}
        if ([versions.plugin, versions.dsh, versions.minimumAndroidApp].every(value => typeof value === 'string')) {
          detail += ` plugin ${String(versions.plugin)}, DSH ${String(versions.dsh)}, Android ${String(versions.minimumAndroidApp)}.`
        }
      }
      if (reason === 'remote-controller-error') {
        const controllerActionKeys: Readonly<Record<string, string>> = {
          component_missing: 'remoteUnavailableTailscale', funnel_permission_required: 'funnelPermission', funnel_https_required: 'funnelHttps', funnel_start_failed: 'funnelStart', funnel_start_timeout: 'funnelTimeout', tailscale_dns_missing: 'tailscaleDnsMissing',
          sidecar_launch_failed: 'remoteUnavailableTailscale', sidecar_stopped: 'controlChannelFailed', sidecar_exited: 'controlChannelFailed', control_channel_failed: 'controlChannelFailed',
          cpolar_component_missing: 'cpolarMissing', cpolar_component_invalid: 'cpolarInvalid', cpolar_config_missing: 'cpolarConfigMissing', cpolar_config_invalid: 'cpolarConfigInvalid', cpolar_start_timeout: 'cpolarTimeout', cpolar_stopped: 'cpolarStopped', cpolar_exited: 'cpolarExited', gateway_start_failed: 'gatewayStartFailed',
        }
        const actionKey = controllerActionKeys[values.controllerCode ?? '']
        if (actionKey !== undefined) action = t(actionKey)
      }
      return { detail, action }
    }
    const appendGroup = (label: string, groupEntries: Record<string, unknown>[]): void => {
      if (groupEntries.length === 0) return
      const group = element('section', 'dsh-mobile-control__diagnostic-group')
      const groupHeader = element('header', 'dsh-mobile-control__diagnostic-group-header')
      const groupTitle = element('h3'); groupTitle.textContent = label
      const groupCount = element('span'); groupCount.textContent = t('diagnosticItems', { count: groupEntries.length })
      const list = element('div', 'dsh-mobile-control__diagnostic-list'); list.setAttribute('role', 'list')
      groupHeader.append(groupTitle, groupCount)
      for (const entry of groupEntries) {
        const state = statusOf(entry)
        const row = element('section', `dsh-mobile-control__diagnostic-check is-${state}`); row.setAttribute('role', 'listitem')
        const marker = element('span', 'dsh-mobile-control__diagnostic-marker'); marker.setAttribute('aria-hidden', 'true')
        const rowBody = element('div', 'dsh-mobile-control__diagnostic-check-body')
        const rowHeader = element('div', 'dsh-mobile-control__diagnostic-check-header')
        const labelKey = typeof entry.id === 'string' ? diagnosticLabelKeys[entry.id] : undefined
        const rowTitle = element('strong'); rowTitle.textContent = locale !== 'zh' && labelKey !== undefined ? t(labelKey) : typeof entry.label === 'string' ? entry.label : t('diagnosticCheck')
        const badge = element('span', 'dsh-mobile-control__diagnostic-badge'); badge.textContent = statusLabels[state]!
        const localizedCopy = localizedEntryCopy(entry)
        const detail = element('p'); detail.textContent = localizedCopy.detail
        rowHeader.append(rowTitle, badge); rowBody.append(rowHeader, detail)
        if (localizedCopy.action !== '') {
          const action = element('p', 'dsh-mobile-control__diagnostic-action')
          const actionLabel = element('span'); actionLabel.textContent = t('diagnosticAction')
          action.append(actionLabel, document.createTextNode(localizedCopy.action)); rowBody.append(action)
        }
        row.append(marker, rowBody); list.append(row)
      }
      group.append(groupHeader, list); diagnosticsChecks.append(group)
    }
    const issues = entries.filter(entry => statusOf(entry) === 'error' || statusOf(entry) === 'warning')
    const otherChecks = entries.filter(entry => statusOf(entry) !== 'error' && statusOf(entry) !== 'warning')
    appendGroup(t('diagnosticNeedsAction'), issues)
    appendGroup(issues.length === 0 ? t('diagnosticDetails') : t('diagnosticOther'), otherChecks)
    diagnosticsSummaryMeta.textContent = issues.length === 0
      ? t('diagnosticNoBlockers', { count: entries.length })
      : t('diagnosticNeedsCount', { count: entries.length, issues: issues.length })
    diagnosticsChecks.hidden = entries.length === 0
    const reportCopy = LOCALIZED_DIAGNOSTIC_COPY[locale]
    const generatedAt = typeof data.generatedAt === 'number' ? new Date(data.generatedAt).toLocaleString(localeTag) : new Date().toLocaleString(localeTag)
    const lines = entries.map(entry => {
      const state = statusOf(entry)
      const labelKey = typeof entry.id === 'string' ? diagnosticLabelKeys[entry.id] : undefined
      const label = labelKey === undefined && typeof entry.label === 'string' ? entry.label : labelKey === undefined ? t('diagnosticCheck') : t(labelKey)
      const localizedCopy = localizedEntryCopy(entry)
      return `[${statusLabels[state]!}] ${label}: ${localizedCopy.detail}${localizedCopy.action === '' ? '' : ` ${localizedCopy.action}`}`
    })
    copiedDiagnosticReport = [reportCopy.reportTitle, `${reportCopy.generated}: ${generatedAt}`, ...lines].join('\n')
    diagnosticsReport.textContent = copiedDiagnosticReport
    diagnosticsDetails.hidden = copiedDiagnosticReport === ''
    diagnosticsCopy.disabled = copiedDiagnosticReport === ''
    diagnosticsCopy.hidden = copiedDiagnosticReport === ''
    diagnosticsToolbar.classList.toggle('has-report', copiedDiagnosticReport !== '')
  }
  const showDiagnosticsFailure = (error: unknown): void => {
    diagnosticsSummary.className = 'dsh-mobile-control__diagnostic-summary is-error'
    diagnosticsSummaryTitle.textContent = t('diagnosticsIncomplete')
    diagnosticsSummaryText.textContent = t('diagnosticsReadFailed', { error: String(error) })
    diagnosticsSummaryMeta.textContent = t('diagnosticsUnavailable')
    diagnosticsChecks.replaceChildren()
    diagnosticsChecks.hidden = true
    copiedDiagnosticReport = ''
    diagnosticsReport.textContent = ''
    diagnosticsDetails.hidden = true
    diagnosticsCopy.disabled = true
    diagnosticsCopy.hidden = true
    diagnosticsToolbar.classList.remove('has-report')
  }
  const loadDiagnostics = (): void => {
    if (diagnosticsBusy) return
    diagnosticsBusy = true
    diagnosticsRun.disabled = true
    diagnosticsRun.setAttribute('aria-busy', 'true')
    diagnosticsRun.textContent = t('diagnosticsChecking')
    diagnosticsSummary.className = 'dsh-mobile-control__diagnostic-summary is-running'
    diagnosticsSummaryTitle.textContent = t('diagnosticsCheckingTitle')
    diagnosticsSummaryText.textContent = t('diagnosticsCheckingText')
    diagnosticsSummaryMeta.textContent = t('diagnosticsRunningMeta')
    diagnosticsFeedback.hidden = true
    diagnosticsChecks.classList.add('is-refreshing')
    diagnosticsChecks.setAttribute('aria-busy', 'true')
    void controlRequestJson('/api/mobile-access/diagnostics').then(
      data => { renderDiagnosticPayloadSafely(data, renderDiagnostics, showDiagnosticsFailure) },
      showDiagnosticsFailure,
    ).finally(() => {
      diagnosticsBusy = false
      diagnosticsRun.disabled = false
      diagnosticsRun.setAttribute('aria-busy', 'false')
      diagnosticsRun.textContent = t('diagnosticsRetry')
      diagnosticsChecks.classList.remove('is-refreshing')
      diagnosticsChecks.setAttribute('aria-busy', 'false')
    })
  }
  diagnosticsEntry.addEventListener('click', () => {
    if (!diagnosticsView.hidden) { selectView(previousAccessView); return }
    selectView('diagnostics'); loadDiagnostics()
  })
  diagnosticsRun.addEventListener('click', loadDiagnostics)
  diagnosticsCopy.addEventListener('click', () => {
    if (copiedDiagnosticReport === '') return
    void navigator.clipboard.writeText(copiedDiagnosticReport).then(() => {
      diagnosticsFeedback.textContent = t('diagnosticsCopied')
      diagnosticsFeedback.hidden = false
    }, () => {
      diagnosticsDetails.open = true
      diagnosticsFeedback.textContent = t('diagnosticsCopyManual')
      diagnosticsFeedback.hidden = false
    })
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
  void controlRequestJson('/api/mobile-access/lan/control').then(render, error => { status.textContent = t('requestFailed', { error: String(error) }) })
  loadRemote()
  const remotePoll = window.setInterval(() => { if (!panel.hidden && !remoteView.hidden) loadRemote() }, 1_500)
  return { remove: () => { lifecycle.abort(); window.clearInterval(remotePoll); window.removeEventListener('focus', retryAfterSetup); document.removeEventListener('visibilitychange', retryAfterSetup); document.removeEventListener('pointerdown', dismiss); root.remove() }, toggle: () => { setOpen(panel.hidden !== false) } }
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

export function registerUniqueDisposable<T extends { readonly dispose: () => void }>(
  entries: Map<string, T>,
  claimedIds: Set<string>,
  id: string,
  mount: () => T,
): () => void {
  if (claimedIds.has(id)) throw new Error(`duplicate lifecycle id: ${id}`)
  claimedIds.add(id)
  let mounted: T
  try { mounted = mount() } catch (error) { claimedIds.delete(id); throw error }
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    mounted.dispose()
  }
  const entry = { ...mounted, dispose } as T
  entries.set(id, entry)
  return () => {
    if (entries.get(id) === entry) { entries.delete(id); claimedIds.delete(id) }
    dispose()
  }
}

/** Dispose resources omitted by a successfully fetched authoritative manifest. */
export function reconcileRemovedExtensions(currentIds: Iterable<string>, seen: ReadonlySet<string>, dispose: (id: string) => void): void {
  for (const id of new Set(currentIds)) if (!seen.has(id)) dispose(id)
}

/** Publish validated authority before resource loading can hang or time out. */
export function publishAuthoritativeExtensionIds(
  authoritativeIds: Set<string>,
  seen: ReadonlySet<string>,
  managedIdSources: readonly Iterable<string>[],
  dispose: (id: string) => void,
): void {
  const current = new Set(authoritativeIds)
  for (const source of managedIdSources) for (const id of source) current.add(id)
  reconcileRemovedExtensions(current, seen, dispose)
  authoritativeIds.clear()
  for (const id of seen) authoritativeIds.add(id)
}

interface MobileExtensionManifestEntry {
  readonly id: string
  readonly scriptUrl?: string
  readonly styleUrl?: string
}
interface MobileExtensionManifest {
  readonly extensions: readonly MobileExtensionManifestEntry[]
  readonly legacy: { readonly scriptRevision: string; readonly styleRevision: string }
}

function validManifestResourceUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('://')
    && !value.split('/').some(part => part === '..' || part === '.')
}

/** Validate the manifest before treating it as authoritative state. */
export function parseMobileExtensionManifest(payload: unknown): MobileExtensionManifest | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const candidate = payload as { protocol?: unknown; extensions?: unknown; legacy?: unknown }
  if (candidate.protocol !== 1 || !Array.isArray(candidate.extensions) || typeof candidate.legacy !== 'object' || candidate.legacy === null) return undefined
  const legacy = candidate.legacy as { scriptRevision?: unknown; styleRevision?: unknown }
  if (typeof legacy.scriptRevision !== 'string' || typeof legacy.styleRevision !== 'string') return undefined
  const ids = new Set<string>()
  const extensions: MobileExtensionManifestEntry[] = []
  for (const value of candidate.extensions) {
    if (typeof value !== 'object' || value === null) return undefined
    const entry = value as { id?: unknown; scriptUrl?: unknown; styleUrl?: unknown }
    if (typeof entry.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(entry.id) || ids.has(entry.id)) return undefined
    if (entry.scriptUrl !== undefined && !validManifestResourceUrl(entry.scriptUrl)) return undefined
    if (entry.styleUrl !== undefined && !validManifestResourceUrl(entry.styleUrl)) return undefined
    ids.add(entry.id)
    extensions.push({ id: entry.id, ...(entry.scriptUrl === undefined ? {} : { scriptUrl: entry.scriptUrl }), ...(entry.styleUrl === undefined ? {} : { styleUrl: entry.styleUrl }) })
  }
  return { extensions, legacy: { scriptRevision: legacy.scriptRevision, styleRevision: legacy.styleRevision } }
}

/** A missing manifest is authoritative before optional legacy resources finish refreshing. */
export async function handleMissingExtensionManifest(
  clearManifestResources: () => void,
  refreshLegacyResources: () => Promise<readonly boolean[]>,
  signal: AbortSignal,
): Promise<boolean> {
  clearManifestResources()
  const results = await refreshLegacyResources()
  return !signal.aborted && results.every(Boolean)
}

interface LifecycleSchedulerRuntime {
  readonly document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setTimeout' | 'clearTimeout'>
}

function refreshAborted(signal: AbortSignal): boolean { return signal.aborted }

/** Run one coalesced refresh cycle, slowing down when the page is hidden. */
export function startLifecycleRefreshScheduler(
  refresh: (signal: AbortSignal) => void | Promise<void>,
  options: { readonly visibleIntervalMs?: number; readonly hiddenIntervalMs?: number; readonly cycleTimeoutMs?: number } = {},
  runtime: LifecycleSchedulerRuntime = { document, window },
): () => void {
  const visibleIntervalMs = options.visibleIntervalMs ?? 45_000
  const hiddenIntervalMs = options.hiddenIntervalMs ?? 300_000
  const cycleTimeoutMs = options.cycleTimeoutMs ?? 30_000
  let timer: number | undefined
  let cycleTimer: number | undefined
  let running = false
  let queued = false
  let disposed = false
  let controller: AbortController | undefined
  const clearTimer = (): void => {
    if (timer === undefined) return
    runtime.window.clearTimeout(timer)
    timer = undefined
  }
  const clearCycleTimer = (): void => {
    if (cycleTimer === undefined) return
    runtime.window.clearTimeout(cycleTimer)
    cycleTimer = undefined
  }
  const schedule = (): void => {
    if (disposed) return
    clearTimer()
    const delay = runtime.document.visibilityState === 'hidden' ? hiddenIntervalMs : visibleIntervalMs
    timer = runtime.window.setTimeout(run, delay)
  }
  const run = (): void => {
    if (disposed) return
    clearTimer()
    if (running) { queued = true; return }
    running = true
    const current = new AbortController()
    controller = current
    const refreshPromise = Promise.resolve().then(() => refresh(current.signal))
    const timeoutPromise = new Promise<void>(resolve => {
      cycleTimer = runtime.window.setTimeout(() => {
        cycleTimer = undefined
        current.abort(new DOMException('mobile extension refresh timed out', 'TimeoutError'))
        resolve()
      }, cycleTimeoutMs)
    })
    void Promise.race([refreshPromise, timeoutPromise]).catch(() => { /* Keep the last good resources during reconnects. */ }).finally(() => {
      clearCycleTimer()
      if (controller === current) controller = undefined
      running = false
      if (disposed) return
      if (queued) { queued = false; run() } else schedule()
    })
    void refreshPromise.catch(() => { /* A timed-out refresh may reject after the scheduler has moved on. */ })
  }
  const onVisibilityChange = (): void => {
    if (runtime.document.visibilityState === 'hidden') schedule()
    else run()
  }
  runtime.document.addEventListener('visibilitychange', onVisibilityChange)
  runtime.window.addEventListener('focus', run)
  runtime.window.addEventListener('online', run)
  run()
  return () => {
    disposed = true
    queued = false
    controller?.abort()
    controller = undefined
    clearCycleTimer()
    clearTimer()
    runtime.document.removeEventListener('visibilitychange', onVisibilityChange)
    runtime.window.removeEventListener('focus', run)
    runtime.window.removeEventListener('online', run)
  }
}

export interface ActivationWork<T> {
  readonly result: Promise<T>
  readonly cancel: () => void
  readonly commit?: (value: T) => void
  readonly dispose: (value: T) => void
}

interface PendingActivation<T> {
  readonly key: object
  readonly generation: number
  readonly controller: AbortController
  readonly cancel: () => void
  readonly completion: Promise<boolean>
}

/** Keep at most one activation in flight per id and commit only its latest generation. */
export class PerIdActivationLifecycle<T> {
  private readonly active = new Map<string, { readonly value: T; readonly dispose: () => void }>()
  private readonly pending = new Map<string, PendingActivation<T>>()
  private readonly generations = new Map<string, number>()
  private disposed = false

  hasActive(id: string): boolean { return this.active.has(id) }
  getActive(id: string): T | undefined { return this.active.get(id)?.value }
  pendingCount(): number { return this.pending.size }

  async activate(
    id: string,
    key: object,
    cycleSignal: AbortSignal | undefined,
    create: (controller: AbortController, generation: number) => ActivationWork<T>,
  ): Promise<boolean> {
    if (this.disposed || cycleSignal?.aborted === true) return false
    const existing = this.pending.get(id)
    if (existing !== undefined) {
      if (existing.key === key && !existing.controller.signal.aborted) return this.waitFor(existing, cycleSignal)
      existing.cancel()
    }
    const generation = (this.generations.get(id) ?? 0) + 1
    this.generations.set(id, generation)
    const controller = new AbortController()
    let work: ActivationWork<T>
    try { work = create(controller, generation) } catch {
      controller.abort(new DOMException('mobile extension activation failed to start', 'AbortError'))
      return false
    }
    let cancelled = false
    let pending = {} as PendingActivation<T>
    const cancel = (): void => {
      if (cancelled) return
      cancelled = true
      if (this.pending.get(id) === pending) this.pending.delete(id)
      if (this.generations.get(id) === generation) this.generations.set(id, generation + 1)
      controller.abort(new DOMException('mobile extension activation cancelled', 'AbortError'))
      work.cancel()
    }
    const completion = Promise.resolve(work.result).then(value => {
      const current = this.pending.get(id)
      const canCommit = !this.disposed && current === pending && current.generation === this.generations.get(id)
        && !controller.signal.aborted
      if (!canCommit) {
        try { work.dispose(value) } catch { /* A stale extension disposer must not break lifecycle cleanup. */ }
        return false
      }
      try { work.commit?.(value) } catch {
        try { work.dispose(value) } catch { /* Keep the previous active extension intact. */ }
        return false
      }
      const previous = this.active.get(id)
      let valueDisposed = false
      const dispose = (): void => {
        if (valueDisposed) return
        valueDisposed = true
        controller.abort(new DOMException('mobile extension deactivated', 'AbortError'))
        try { work.dispose(value) } catch { /* Disposers are isolated per extension. */ }
      }
      this.active.set(id, { value, dispose })
      previous?.dispose()
      return true
    }, () => {
      cancel()
      return false
    }).finally(() => {
      if (this.pending.get(id) === pending) this.pending.delete(id)
    })
    Object.assign(pending, { key, generation, controller, cancel, completion })
    this.pending.set(id, pending)
    return this.waitFor(pending, cycleSignal)
  }

  remove(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    this.active.get(id)?.dispose()
    this.active.delete(id)
    this.pending.get(id)?.cancel()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const current of this.active.values()) current.dispose()
    this.active.clear()
    for (const current of this.pending.values()) current.cancel()
  }

  private waitFor(pending: PendingActivation<T>, signal: AbortSignal | undefined): Promise<boolean> {
    if (signal === undefined) return pending.completion
    if (signal.aborted) { pending.cancel(); return Promise.resolve(false) }
    return new Promise<boolean>(resolve => {
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = (): void => { pending.cancel(); finish(false) }
      signal.addEventListener('abort', onAbort, { once: true })
      void pending.completion.then(finish)
    })
  }
}

function installCustomAssets(): () => void {
  const legacyStyle = element('style'); legacyStyle.dataset.plugin = 'dsh-mobile-custom'; document.head.append(legacyStyle)
  const legacyCssState = { etag: '', modified: '' }
  const previous = window.dshMobile
  let legacyMount: MobileExtensionMount | undefined = queuedLegacyMount
  let legacySource = ''
  let legacyRoot: HTMLElement | undefined
  let legacyDispose: (() => void) | undefined
  const definitions = new Map<string, MobileClientDefinition>()
  type ExtensionSurfaceEntry = { readonly dispose: () => void; readonly container: HTMLElement; readonly host: () => HTMLElement }
  type ActiveExtension = { readonly controller: AbortController; readonly surfaces: Map<string, ExtensionSurfaceEntry>; readonly cleanup?: () => void }
  const activations = new PerIdActivationLifecycle<ActiveExtension>()
  const styleNodes = new Map<string, HTMLStyleElement>()
  const styleEtags = new Map<string, string>()
  const scriptDigests = new Map<string, string>()
  const manifestExtensionIds = new Set<string>()
  const managedDefinitionIds = new Set<string>()
  let manifestEtag = ''
  let disposed = false
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
  const invokeNative = async (action: string, input: unknown, signal: AbortSignal): Promise<unknown> => {
    const abortReason = (): unknown => signal.reason ?? new DOMException('mobile extension disposed', 'AbortError')
    if (signal.aborted) throw abortReason()
    const bridge = window.__DSH_MOBILE_NATIVE__
    if (bridge !== undefined) {
      return new Promise<unknown>((resolve, reject) => {
        let settled = false
        const finish = (callback: () => void): void => { if (settled) return; settled = true; signal.removeEventListener('abort', onAbort); callback() }
        const onAbort = (): void => { finish(() => { reject(abortReason()) }) }
        signal.addEventListener('abort', onAbort, { once: true })
        void Promise.resolve().then(() => bridge.invoke(action, input)).then(
          value => { finish(() => { resolve(materializeNativeFile(value)) }) },
          error => { finish(() => { reject(error) }) },
        )
      })
    }
    if (action === 'share' && typeof navigator.share === 'function') { await navigator.share((input ?? {}) as ShareData); return { ok: true } }
    if (action === 'clipboard.read' && navigator.clipboard !== undefined) return { text: await navigator.clipboard.readText() }
    if (action === 'clipboard.write' && navigator.clipboard !== undefined) { await navigator.clipboard.writeText(typeof input === 'object' && input !== null && 'text' in input ? String((input as { text: unknown }).text) : ''); return { ok: true } }
    if (action === 'files.pick' || action === 'camera.capture') {
      const inputElement = element('input')
      inputElement.type = 'file'
      inputElement.accept = action === 'camera.capture' ? 'image/*' : '*/*'
      if (action === 'camera.capture') inputElement.capture = 'environment'
      inputElement.hidden = true
      return new Promise<File | undefined>((resolve, reject) => {
        let settled = false
        let cleaned = false
        let cleanupTimer = 0
        let watchdogTimer = 0
        const cleanup = (): void => {
          if (cleaned) return
          cleaned = true
          if (cleanupTimer !== 0) window.clearTimeout(cleanupTimer)
          if (watchdogTimer !== 0) window.clearTimeout(watchdogTimer)
          window.removeEventListener('focus', scheduleCancel)
          document.removeEventListener('visibilitychange', onVisibilityChange)
          signal.removeEventListener('abort', onAbort)
          inputElement.removeEventListener('change', onChange)
          inputElement.removeEventListener('cancel', onCancel)
          inputElement.remove()
        }
        const finish = (callback: () => void): void => { if (settled) return; settled = true; cleanup(); callback() }
        const onChange = (): void => { const file = inputElement.files?.[0]; finish(() => { resolve(file) }) }
        const onCancel = (): void => { finish(() => { resolve(undefined) }) }
        const onAbort = (): void => { finish(() => { reject(abortReason()) }) }
        const scheduleCancel = (): void => { if (!settled && cleanupTimer === 0) cleanupTimer = window.setTimeout(onCancel, 1000) }
        const onVisibilityChange = (): void => { if (document.visibilityState === 'visible') scheduleCancel() }
        inputElement.addEventListener('change', onChange, { once: true })
        inputElement.addEventListener('cancel', onCancel, { once: true })
        window.addEventListener('focus', scheduleCancel)
        document.addEventListener('visibilitychange', onVisibilityChange)
        signal.addEventListener('abort', onAbort, { once: true })
        watchdogTimer = window.setTimeout(onCancel, 300_000)
        try {
          document.body.append(inputElement)
          inputElement.click()
        } catch (error) {
          finish(() => { reject(error) })
        }
      })
    }
    throw new Error('native capability is unavailable')
  }
  const makeApi = (id: string, controller: AbortController, surfaces: Map<string, ExtensionSurfaceEntry>, surfaceIds: Set<string>): MobileClientApi => {
    const ensureCurrent = (): void => { if (controller.signal.aborted) throw controller.signal.reason }
    const requestSignal = (signal?: AbortSignal | null): AbortSignal => signal === undefined || signal === null
      ? controller.signal
      : AbortSignal.any([controller.signal, signal])
    const mountSurface = (surface: MobileSurface): (() => void) => {
      ensureCurrent()
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(surface.id) || surface.label.length > 120) throw new Error('invalid mobile surface')
      return registerUniqueDisposable(surfaces, surfaceIds, surface.id, () => {
        const container = element('section'); container.dataset.dshMobileSurface = surface.id; container.hidden = surface.placement === 'page' || surface.placement === 'overlay'; container.style.cssText = surface.placement === 'page' || surface.placement === 'overlay' ? 'position:absolute;inset:0;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fff);padding:16px;pointer-events:auto' : 'pointer-events:auto'
        const host = (): HTMLElement => surface.placement === 'page' || surface.placement === 'overlay' ? shellLayer() : surfaceHost(surface.placement) ?? shellLayer()
        const mounted = surface.mount(container)
        const dispose = (): void => { try { if (typeof mounted === 'function') mounted() } finally { container.remove() } }
        return { dispose, container, host }
      })
    }
    return {
      host: {
        invoke: (action: string, input: unknown) => {
          ensureCurrent()
          return mobileRequest(`/mobile-access/extensions/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`, { method: 'POST', body: JSON.stringify(input ?? {}), signal: controller.signal }).then(async response => { const value = await response.json() as unknown; if (!response.ok) throw new Error(typeof value === 'object' && value !== null && 'error' in value ? String((value as { error: unknown }).error) : `HTTP ${String(response.status)}`); return value })
        },
        fetch: (path: string, init?: RequestInit) => {
          ensureCurrent()
          if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')
            || path.split('/').some(part => part === '..' || part === '.')) throw new TypeError('extension routes must be relative')
          return mobileRequest(`/mobile-access/extensions/${encodeURIComponent(id)}/routes${path}`, { ...init, signal: requestSignal(init?.signal) })
        },
      },
      ui: {
        registerSurface: mountSurface,
        open: surfaceId => { ensureCurrent(); const entry = surfaces.get(surfaceId); if (entry !== undefined) entry.container.hidden = false },
        close: surfaceId => { ensureCurrent(); const entry = surfaces.get(surfaceId); if (entry !== undefined) entry.container.hidden = true },
        toast: message => { ensureCurrent(); toast(message) },
      },
      native: {
        capabilities: async () => { ensureCurrent(); const bridge = window.__DSH_MOBILE_NATIVE__; return bridge === undefined ? ['files.pick', 'camera.capture', 'share', 'clipboard.read', 'clipboard.write'] : bridge.capabilities() },
        invoke: (action, input) => invokeNative(action, input, controller.signal),
      },
      signal: controller.signal, document, window,
    }
  }
  const activateDefinition = (definition: MobileClientDefinition, cycleSignal?: AbortSignal): Promise<boolean> => activations.activate(
    definition.id,
    definition,
    cycleSignal,
    controller => {
      const surfaces = new Map<string, ExtensionSurfaceEntry>()
      const surfaceIds = new Set<string>()
      let pendingDisposed = false
      const disposePending = (): void => {
        if (pendingDisposed) return
        pendingDisposed = true
        for (const surface of surfaces.values()) {
          try { surface.dispose() } catch { /* Dispose every staged surface independently. */ }
        }
        surfaces.clear()
        surfaceIds.clear()
      }
      const result = Promise.resolve().then(() => definition.activate(makeApi(definition.id, controller, surfaces, surfaceIds))).then(cleanup => ({
        controller,
        surfaces,
        ...(typeof cleanup === 'function' ? { cleanup } : {}),
      }))
      return {
        result,
        cancel: disposePending,
        commit: value => {
          if (definitions.get(definition.id) !== definition || controller.signal.aborted) throw new Error('stale mobile extension activation')
          for (const surface of value.surfaces.values()) surface.host().append(surface.container)
        },
        dispose: value => {
          controller.abort(new DOMException('mobile extension disposed', 'AbortError'))
          try { value.cleanup?.() } finally { disposePending() }
        },
      }
    },
  )
  const define = (definition: MobileClientDefinition): void => {
    if (disposed || definition.apiVersion !== 1 || !/^[a-z][a-z0-9-]{0,63}$/u.test(definition.id) || typeof definition.activate !== 'function') return
    if (expectedDefinitionId !== undefined && definition.id !== expectedDefinitionId) return
    definitions.set(definition.id, definition)
    if (started && expectedDefinitionId === undefined) void activateDefinition(definition)
  }
  let started = false
  window.dshMobile = Object.freeze({ register: mount => { legacyMount = mount }, define })
  for (const definition of queuedDefinitions.splice(0)) define(definition)
  let legacyJsEtag = ''
  let legacyJsModified = ''
  const refreshLegacy = async (signal: AbortSignal): Promise<boolean> => {
    const previousMount = legacyMount
    let pendingRoot: HTMLElement | undefined
    try {
      const headers: Record<string, string> = {}
      if (legacyJsEtag !== '') headers['if-none-match'] = legacyJsEtag
      if (legacyJsModified !== '') headers['if-modified-since'] = legacyJsModified
      const response = await fetch('/mobile-access/custom.js', { credentials: 'same-origin', cache: 'no-store', headers, signal })
      if (response.status === 304) return true
      if (!response.ok) return false
      const nextEtag = response.headers.get('etag') ?? ''
      const nextModified = response.headers.get('last-modified') ?? ''
      const next = await response.text()
      if (refreshAborted(signal)) return false
      if (next === legacySource) { legacyJsEtag = nextEtag; legacyJsModified = nextModified; return true }
      legacyMount = undefined
      const script = element('script'); script.textContent = `${next}\n//# sourceURL=dsh-mobile-custom.js`; document.head.append(script); script.remove()
      if (refreshAborted(signal)) { legacyMount = previousMount; return false }
      const mount = legacyMount as MobileExtensionMount | undefined
      if (mount === undefined) {
        legacyDispose?.(); legacyDispose = undefined
        legacyRoot?.remove(); legacyRoot = undefined
        legacySource = next; legacyJsEtag = nextEtag; legacyJsModified = nextModified
        return true
      }
      const nextRoot = element('div'); pendingRoot = nextRoot; nextRoot.dataset.dshMobileExtension = 'true'; document.body.append(nextRoot)
      const nextDispose = mount({ document, request: mobileRequest, root: nextRoot, window })
      if (refreshAborted(signal)) { if (typeof nextDispose === 'function') nextDispose(); pendingRoot.remove(); pendingRoot = undefined; legacyMount = previousMount; return false }
      legacyDispose?.(); legacyRoot?.remove(); legacyRoot = nextRoot; pendingRoot = undefined; legacyDispose = typeof nextDispose === 'function' ? nextDispose : undefined; legacySource = next
      legacyJsEtag = nextEtag; legacyJsModified = nextModified
      return true
    } catch { pendingRoot?.remove(); legacyMount = previousMount; return false }
  }
  let legacyScriptRevision = ''
  let legacyStyleRevision = ''
  const disposeManifestExtension = (id: string): void => {
    activations.remove(id)
    styleNodes.get(id)?.remove(); styleNodes.delete(id); styleEtags.delete(id); scriptDigests.delete(id)
    if (managedDefinitionIds.delete(id)) definitions.delete(id)
  }
  const managedManifestIdSources = (): readonly Iterable<string>[] => [styleNodes.keys(), styleEtags.keys(), scriptDigests.keys(), managedDefinitionIds]
  const clearManifestExtensions = (): void => {
    publishAuthoritativeExtensionIds(manifestExtensionIds, new Set(), managedManifestIdSources(), disposeManifestExtension)
    manifestEtag = ''
  }
  const refreshExtensions = async (signal: AbortSignal): Promise<boolean> => {
    try {
      const headers: Record<string, string> = {}
      if (manifestEtag !== '') headers['if-none-match'] = manifestEtag
      const response = await fetch('/mobile-access/extensions/manifest', { credentials: 'same-origin', cache: 'no-store', headers, signal })
      if (response.status === 404) {
        legacyScriptRevision = ''
        legacyStyleRevision = ''
        return handleMissingExtensionManifest(
          clearManifestExtensions,
          () => Promise.all([refreshLegacy(signal), refreshCssLegacy(legacyStyle, signal, legacyCssState)]),
          signal,
        )
      }
      if (response.status === 304) return true
      if (!response.ok) return false
      const nextManifestEtag = response.headers.get('etag') ?? ''
      const payload = parseMobileExtensionManifest(await response.json())
      if (refreshAborted(signal) || payload === undefined) return false
      const entries = payload.extensions
      const seen = new Set(entries.map(entry => entry.id))
      publishAuthoritativeExtensionIds(manifestExtensionIds, seen, managedManifestIdSources(), disposeManifestExtension)
      const scriptRevision = payload.legacy.scriptRevision
      const styleRevision = payload.legacy.styleRevision
      let refreshComplete = true
      if (scriptRevision === '' || scriptRevision !== legacyScriptRevision) {
        if (await refreshLegacy(signal)) legacyScriptRevision = scriptRevision
        else refreshComplete = false
      }
      if (styleRevision === '' || styleRevision !== legacyStyleRevision) {
        if (await refreshCssLegacy(legacyStyle, signal, legacyCssState)) legacyStyleRevision = styleRevision
        else refreshComplete = false
      }
      for (const entry of entries) {
        if (entry.styleUrl === undefined) {
          styleNodes.get(entry.id)?.remove(); styleNodes.delete(entry.id); styleEtags.delete(entry.id)
        }
        if (entry.scriptUrl === undefined) {
          activations.remove(entry.id); scriptDigests.delete(entry.id)
          if (managedDefinitionIds.delete(entry.id)) definitions.delete(entry.id)
        }
        try {
          let pendingCss: string | undefined
          let pendingStyleEtag: string | undefined
          const cssUrl = typeof entry.styleUrl === 'string' ? entry.styleUrl : undefined
          if (cssUrl !== undefined) {
            const cssHeaders: Record<string, string> = {}
            const storedEtag = styleEtags.get(entry.id)
            if (storedEtag !== undefined) cssHeaders['if-none-match'] = storedEtag
            const cssResponse = await fetch(cssUrl, { credentials: 'same-origin', cache: 'no-store', headers: cssHeaders, signal })
            if (cssResponse.status !== 304) {
              if (!cssResponse.ok) throw new Error('mobile extension style failed to load')
              pendingStyleEtag = cssResponse.headers.get('etag') ?? undefined
              pendingCss = await cssResponse.text()
              if (refreshAborted(signal)) return false
            }
          }

          const scriptUrl = typeof entry.scriptUrl === 'string' ? entry.scriptUrl : undefined
          if (scriptUrl !== undefined) {
            const scriptHeaders: Record<string, string> = {}
            const storedDigest = scriptDigests.get(entry.id)
            if (storedDigest !== undefined) scriptHeaders['if-none-match'] = storedDigest
            const scriptResponse = await fetch(scriptUrl, { credentials: 'same-origin', cache: 'no-store', headers: scriptHeaders, signal })
            if (scriptResponse.status !== 304) {
              if (!scriptResponse.ok) throw new Error('mobile extension script failed to load')
              const source = await scriptResponse.text()
              if (refreshAborted(signal)) return false
              const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
              if (refreshAborted(signal)) return false
              const key = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
              if (scriptDigests.get(entry.id) !== key) {
                const previousDefinition = definitions.get(entry.id)
                try {
                  expectedDefinitionId = entry.id
                  try {
                    const script = element('script'); script.textContent = `${source}\n//# sourceURL=dsh-mobile-extension-${entry.id}.js`; document.head.append(script); script.remove()
                  } finally { expectedDefinitionId = undefined }
                  const nextDefinition = definitions.get(entry.id)
                  if (nextDefinition === undefined || nextDefinition === previousDefinition) throw new Error('mobile extension did not define its manifest id')
                  if (!await activateDefinition(nextDefinition, signal)) throw new Error('mobile extension activation failed')
                  if (refreshAborted(signal)) return false
                  managedDefinitionIds.add(entry.id)
                  scriptDigests.set(entry.id, key)
                } catch (error) {
                  if (previousDefinition === undefined) definitions.delete(entry.id)
                  else definitions.set(entry.id, previousDefinition)
                  throw error
                }
              }
            }
            const definition = definitions.get(entry.id)
            if (definition !== undefined && !activations.hasActive(entry.id) && !await activateDefinition(definition, signal)) throw new Error('mobile extension activation failed')
          }

          if (refreshAborted(signal)) return false
          if (pendingCss !== undefined) {
            const oldStyle = styleNodes.get(entry.id)
            if (oldStyle?.textContent !== pendingCss) {
              const node = element('style'); node.dataset.dshMobileExtensionStyle = entry.id; node.textContent = pendingCss; document.head.append(node); styleNodes.set(entry.id, node); oldStyle?.remove()
            }
            if (pendingStyleEtag !== undefined && pendingStyleEtag !== '') styleEtags.set(entry.id, pendingStyleEtag)
          }
        } catch {
          refreshComplete = false
        }
      }
      if (refreshAborted(signal)) return false
      manifestEtag = refreshComplete ? nextManifestEtag : ''
      return refreshComplete
    } catch { return false }
  }
  started = true
  for (const definition of definitions.values()) void activateDefinition(definition)
  const stopRefresh = startLifecycleRefreshScheduler(async signal => {
    await refreshExtensions(signal)
  })
  return () => { disposed = true; stopRefresh(); started = false; legacyDispose?.(); legacyDispose = undefined; legacyRoot?.remove(); legacyRoot = undefined; legacyStyle.remove(); activations.dispose(); for (const node of styleNodes.values()) node.remove(); styleNodes.clear(); const layer = document.querySelector('[data-dsh-mobile-extension-layer]'); layer?.remove(); for (const host of document.querySelectorAll('[data-dsh-mobile-surface-host]')) host.remove(); if (previous === undefined) delete window.dshMobile; else window.dshMobile = previous }
}

interface LegacyCssState { etag: string; modified: string }
async function refreshCssLegacy(style: HTMLStyleElement, signal: AbortSignal, state: LegacyCssState): Promise<boolean> {
  try {
    const headers: Record<string, string> = {}
    if (state.etag !== '') headers['if-none-match'] = state.etag
    if (state.modified !== '') headers['if-modified-since'] = state.modified
    let response = await fetch('/mobile-access/custom.css', { credentials: 'same-origin', cache: 'no-store', headers, signal })
    if (response.status === 304 && style.textContent === '') {
      state.etag = ''
      state.modified = ''
      response = await fetch('/mobile-access/custom.css', { credentials: 'same-origin', cache: 'no-store', signal })
    }
    if (response.status === 304) return true
    if (response.ok) {
      const nextEtag = response.headers.get('etag') ?? ''
      const nextModified = response.headers.get('last-modified') ?? ''
      const css = await response.text()
      if (refreshAborted(signal)) return false
      style.textContent = css
      state.etag = nextEtag
      state.modified = nextModified
      return true
    }
    return false
  } catch { return false }
}

const CONTROL_STYLES = `
.dsh-mobile-control{position:fixed;z-index:1000;left:16px;bottom:112px;font:14px/1.45 system-ui;color:var(--dsw-alias-label-primary,#16181d)}
.dsh-mobile-control__panel{box-sizing:border-box;width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 140px);overflow-y:auto;padding:16px;border:1px solid var(--dsw-alias-border-subtle,#e1e5eb);border-radius:18px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 18px 50px rgb(15 23 42 / 18%)}
.dsh-mobile-control__header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}.dsh-mobile-control__panel h2{margin:0;font-size:17px;line-height:24px}.dsh-mobile-control__header-actions{display:flex;align-items:center;gap:2px}.dsh-mobile-control__diagnostic-entry,.dsh-mobile-control__close{display:inline-flex;align-items:center;justify-content:center;min-width:44px;height:44px;padding:0;border:0;border-radius:10px;background:transparent;color:inherit;cursor:pointer}.dsh-mobile-control__diagnostic-entry{padding:0 9px;color:#2563eb;font:650 12px/1 system-ui}.dsh-mobile-control__close{font-size:24px;line-height:1}.dsh-mobile-control__diagnostic-entry:hover,.dsh-mobile-control__close:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}
.dsh-mobile-control__app-download{display:flex;align-items:center;justify-content:space-between;box-sizing:border-box;min-height:38px;margin:0 0 10px;padding:8px 11px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:11px;background:var(--dsw-alias-bg-layer-1,#f7f8fa);color:var(--dsw-alias-label-primary,#16181d);font:600 12px/1.3 system-ui;text-decoration:none}.dsh-mobile-control__app-download[hidden]{display:none}.dsh-mobile-control__app-download::after{color:#2563eb;font-size:14px;content:"↗"}.dsh-mobile-control__app-download:hover{border-color:#9fb9e8;background:#f5f8ff;color:#1d4ed8}
.dsh-mobile-control__switcher{display:grid;grid-template-columns:repeat(2,1fr);gap:4px;margin:0 0 14px;padding:4px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#f3f5f8)}.dsh-mobile-control__switcher[hidden]{display:none}.dsh-mobile-control__tab{min-height:36px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#606873);font:600 13px/1 system-ui;cursor:pointer}.dsh-mobile-control__tab.is-active{background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);box-shadow:0 1px 3px rgb(15 23 42 / 10%)}.dsh-mobile-control__view[hidden]{display:none}.dsh-mobile-control__intro{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#606873);font-size:12px;line-height:1.55}.dsh-mobile-control__view.is-remote .dsh-mobile-control__actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.dsh-mobile-control__view.is-remote .dsh-mobile-control__actions button[hidden]{display:none}
.dsh-mobile-control__provider-section{position:relative;margin:0 0 12px}.dsh-mobile-control__section-title{margin:0 0 8px;color:var(--dsw-alias-label-primary,#16181d);font:650 13px/1.4 system-ui}.dsh-mobile-control__provider-section>.dsh-mobile-control__section-title{padding-right:42px}.dsh-mobile-control__provider-choices{display:grid;gap:8px}.dsh-mobile-control__provider{display:flex;flex-direction:column;gap:5px;min-height:68px;padding:11px 12px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:13px;background:#fff;color:inherit;text-align:left;cursor:pointer;transition:border-color 160ms ease,background-color 160ms ease,box-shadow 160ms ease}.dsh-mobile-control__provider:hover{border-color:#9fb9e8;background:#f8fbff}.dsh-mobile-control__provider.is-selected{border-color:#2563eb;background:#f5f8ff;box-shadow:0 0 0 1px #2563eb inset}.dsh-mobile-control__provider:disabled{cursor:wait;opacity:.62}.dsh-mobile-control__provider-top{display:flex;align-items:center;justify-content:space-between;gap:8px}.dsh-mobile-control__provider-top strong{font-size:13px}.dsh-mobile-control__provider-badge{flex:none;padding:3px 7px;border-radius:999px;background:#e8f0ff;color:#1d4ed8;font:650 10px/1.2 system-ui}.dsh-mobile-control__provider-badge.is-cpolar{background:#eaf8f2;color:#087454}.dsh-mobile-control__provider-description{color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.45}.dsh-mobile-control__provider-info{position:absolute;z-index:5;top:-13px;right:-8px}.dsh-mobile-control__provider-info-button{display:flex;align-items:center;justify-content:center;width:44px;height:44px;padding:0;border:0;border-radius:50%;background:transparent;color:#475569;cursor:pointer;touch-action:manipulation}.dsh-mobile-control__provider-info-button:hover{background:#f1f5f9;color:#1d4ed8}.dsh-mobile-control__provider-info-glyph{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:18px;height:18px;border:1.5px solid currentColor;border-radius:50%;font:700 12px/1 system-ui}.dsh-mobile-control__provider-info-popover{position:absolute;z-index:6;top:38px;right:4px;box-sizing:border-box;width:min(292px,calc(100vw - 72px));padding:10px 12px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 10px 28px rgb(15 23 42 / 16%)}.dsh-mobile-control__provider-info-popover[hidden]{display:none}.dsh-mobile-control__provider-info-popover strong,.dsh-mobile-control__provider-info-popover span{display:block}.dsh-mobile-control__provider-info-popover strong{margin-bottom:3px;font-size:12px}.dsh-mobile-control__provider-info-popover span{color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.55}
.dsh-mobile-control__cpolar-setup{margin:0 0 12px;padding:12px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:13px;background:#fff}.dsh-mobile-control__cpolar-setup[hidden],.dsh-mobile-control__cpolar-account[hidden],.dsh-mobile-control__details[hidden],.dsh-mobile-control__view.is-remote .dsh-mobile-control__actions[hidden],.dsh-mobile-control__danger[hidden]{display:none}.dsh-mobile-control__component-status,.dsh-mobile-control__component-note{margin:0 0 10px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.55}.dsh-mobile-control__cpolar-setup>.dsh-mobile-control__primary{width:100%;min-height:44px;padding:9px 12px;border-radius:10px;font:600 12px/1.3 system-ui;cursor:pointer}.dsh-mobile-control__cpolar-account{margin-top:10px}.dsh-mobile-control__link-row{display:flex;flex-wrap:wrap;gap:6px 12px;margin:0 0 10px}.dsh-mobile-control__text-link{color:#2563eb;font-size:11px;text-decoration:none}.dsh-mobile-control__text-link:hover{text-decoration:underline}.dsh-mobile-control__token-label{display:flex;flex-direction:column;gap:5px;margin:0 0 8px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px}.dsh-mobile-control__token{box-sizing:border-box;width:100%;min-height:44px;padding:9px 10px;border:1px solid var(--dsw-alias-border-normal,#cfd5dd);border-radius:10px;background:#fff;color:inherit;font:16px/1.4 system-ui}.dsh-mobile-control__cpolar-connect{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:100%;min-height:44px;padding:10px 14px;border-radius:12px;font:650 13px/1.2 system-ui;cursor:pointer;transition:background-color 160ms ease,border-color 160ms ease,opacity 160ms ease}.dsh-mobile-control__cpolar-connect:hover:not(:disabled){border-color:#1d4ed8;background:#1d4ed8}.dsh-mobile-control__cpolar-connect:active:not(:disabled){border-color:#1e40af;background:#1e40af}.dsh-mobile-control__cpolar-connect:disabled{cursor:wait;opacity:.55}.dsh-mobile-control__details{margin:10px 0 0;border-top:1px solid var(--dsw-alias-border-subtle,#e1e5eb);padding-top:9px}.dsh-mobile-control__details>summary{min-height:30px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:30px;cursor:pointer}.dsh-mobile-control__details-body{display:flex;flex-wrap:wrap;align-items:center;gap:7px 12px;padding:4px 0}.dsh-mobile-control__details-body p{flex:1 0 100%;margin:0;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5}.dsh-mobile-control__storage{display:block;flex:1 0 100%;max-width:100%;overflow:hidden;padding:7px 8px;border-radius:8px;background:#f3f5f8;color:#475569;font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__danger{flex:1 0 100%;min-height:38px;margin-top:3px;padding:7px 10px;border:1px solid #dc2626;border-radius:9px;background:transparent;color:#b91c1c;font:12px/1.3 system-ui;cursor:pointer}
.dsh-mobile-control__access{display:flex;align-items:baseline;gap:6px;min-width:0;margin:0 0 12px}.dsh-mobile-control__access[hidden]{display:none}.dsh-mobile-control__access-label{flex:none;color:var(--dsw-alias-label-secondary,#606873);white-space:nowrap}.dsh-mobile-control__access-label::after{content:"："}.dsh-mobile-control__access-link{min-width:0;overflow:hidden;color:#2563eb;text-decoration:none;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__access-link:hover{text-decoration:underline}.dsh-mobile-control__qr{display:flex;justify-content:center;margin:0 0 12px}.dsh-mobile-control__qr[hidden]{display:none}.dsh-mobile-control__qr img{border-radius:12px;background:#fff;padding:8px}
.dsh-mobile-control__status{margin:0 0 14px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#606873)}.dsh-mobile-control__status::before{display:inline-block;width:8px;height:8px;margin-right:7px;border-radius:50%;background:#98a1ad;content:""}.dsh-mobile-control__status.is-running::before{background:#16a36a}.dsh-mobile-control__status.is-key{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all}
.dsh-mobile-control__guide{margin:0 0 14px;padding:12px;border:1px solid #bfdbfe;border-radius:12px;background:#eff6ff}.dsh-mobile-control__guide[hidden]{display:none}.dsh-mobile-control__guide-title{margin:0;color:#172554;font:650 13px/1.45 system-ui}.dsh-mobile-control__guide-summary,.dsh-mobile-control__guide-note{margin:4px 0 0;color:#475569;font-size:12px;line-height:1.5}.dsh-mobile-control__guide-steps{margin:8px 0 0;padding-left:20px;color:#1e293b;font-size:12px;line-height:1.6}.dsh-mobile-control__guide-note{color:#64748b}.dsh-mobile-control__guide-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.dsh-mobile-control__guide-actions button{min-width:0;min-height:44px;padding:8px;border-radius:10px;font:12px/1.25 system-ui;cursor:pointer}.dsh-mobile-control__guide-actions button:disabled{cursor:not-allowed;opacity:.45}
.dsh-mobile-control__extensions{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#606873);font-size:12px}
.dsh-mobile-control__view.is-diagnostics{--dsh-diagnostic-ok:#087454;--dsh-diagnostic-warning:#a35b00;--dsh-diagnostic-error:#c62828;--dsh-diagnostic-info:#526071}.dsh-mobile-control__diagnostic-summary{box-sizing:border-box;margin:0;padding:13px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:16px;background:var(--dsw-alias-bg-layer-1,#f8fafc)}.dsh-mobile-control__diagnostic-summary-main{display:grid;grid-template-columns:36px minmax(0,1fr);align-items:center;gap:11px}.dsh-mobile-control__diagnostic-summary-icon{position:relative;display:block;width:36px;height:36px;border-radius:50%;background:#e8edf3;color:var(--dsh-diagnostic-info)}.dsh-mobile-control__diagnostic-summary-icon::before,.dsh-mobile-control__diagnostic-summary-icon::after{position:absolute;content:""}.dsh-mobile-control__diagnostic-summary-body{display:flex;min-width:0;flex-direction:column;gap:2px}.dsh-mobile-control__diagnostic-summary-body strong{font-size:13px;line-height:1.35}.dsh-mobile-control__diagnostic-summary-body span{color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5}.dsh-mobile-control__diagnostic-summary-meta{display:block;margin-top:11px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-subtle,#dbe1e8);color:var(--dsw-alias-label-secondary,#606873);font-size:10px;line-height:1.45}.dsh-mobile-control__diagnostic-summary.is-ok .dsh-mobile-control__diagnostic-summary-icon{background:#e6f7f0;color:var(--dsh-diagnostic-ok)}.dsh-mobile-control__diagnostic-summary.is-ok .dsh-mobile-control__diagnostic-summary-icon::before{top:10px;left:10px;width:13px;height:7px;border-bottom:2px solid currentColor;border-left:2px solid currentColor;transform:rotate(-45deg)}.dsh-mobile-control__diagnostic-summary.is-attention .dsh-mobile-control__diagnostic-summary-icon{background:#fff4dc;color:var(--dsh-diagnostic-warning)}.dsh-mobile-control__diagnostic-summary.is-error .dsh-mobile-control__diagnostic-summary-icon{background:#fdecec;color:var(--dsh-diagnostic-error)}.dsh-mobile-control__diagnostic-summary.is-attention .dsh-mobile-control__diagnostic-summary-icon::before,.dsh-mobile-control__diagnostic-summary.is-error .dsh-mobile-control__diagnostic-summary-icon::before{top:8px;left:17px;width:2px;height:13px;border-radius:2px;background:currentColor}.dsh-mobile-control__diagnostic-summary.is-attention .dsh-mobile-control__diagnostic-summary-icon::after,.dsh-mobile-control__diagnostic-summary.is-error .dsh-mobile-control__diagnostic-summary-icon::after{bottom:8px;left:17px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-mobile-control__diagnostic-summary.is-running .dsh-mobile-control__diagnostic-summary-icon{background:#e8f0ff;color:#2563eb}.dsh-mobile-control__diagnostic-summary.is-running .dsh-mobile-control__diagnostic-summary-icon::before{inset:9px;border:2px solid rgb(37 99 235 / 24%);border-top-color:currentColor;border-radius:50%;animation:dsh-diagnostic-spin .8s linear infinite}
.dsh-mobile-control__diagnostic-summary.is-idle .dsh-mobile-control__diagnostic-summary-icon::before{top:8px;left:17px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-mobile-control__diagnostic-summary.is-idle .dsh-mobile-control__diagnostic-summary-icon::after{top:13px;left:17px;width:2px;height:11px;border-radius:2px;background:currentColor}
.dsh-mobile-control__diagnostic-toolbar{display:grid;grid-template-columns:1fr;gap:8px;margin-top:10px}.dsh-mobile-control__diagnostic-toolbar.has-report{grid-template-columns:1fr 1fr}.dsh-mobile-control__diagnostic-run,.dsh-mobile-control__diagnostic-copy{box-sizing:border-box;width:100%;min-height:44px;padding:9px 10px;border-radius:11px;font:650 12px/1.3 system-ui;cursor:pointer;touch-action:manipulation}.dsh-mobile-control__diagnostic-copy[hidden]{display:none}.dsh-mobile-control__diagnostic-run:disabled{cursor:wait;opacity:.58}.dsh-mobile-control__diagnostic-feedback{margin:8px 0 0;padding:8px 10px;border-radius:9px;background:#eff6ff;color:#1d4ed8;font-size:11px;line-height:1.45}.dsh-mobile-control__diagnostic-feedback[hidden]{display:none}
.dsh-mobile-control__diagnostic-checks{display:grid;gap:12px;margin-top:12px;animation:dsh-diagnostic-reveal 160ms ease-out both}.dsh-mobile-control__diagnostic-checks[hidden]{display:none}.dsh-mobile-control__diagnostic-group{overflow:hidden;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:13px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__diagnostic-group-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 11px;border-bottom:1px solid var(--dsw-alias-border-subtle,#e1e5eb);background:var(--dsw-alias-bg-layer-1,#f8fafc)}.dsh-mobile-control__diagnostic-group-header h3{margin:0;font:650 11px/1.4 system-ui}.dsh-mobile-control__diagnostic-group-header span{color:var(--dsw-alias-label-secondary,#606873);font-size:10px}.dsh-mobile-control__diagnostic-list{display:flex;flex-direction:column}.dsh-mobile-control__diagnostic-check{display:grid;grid-template-columns:26px minmax(0,1fr);gap:9px;padding:11px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__diagnostic-check + .dsh-mobile-control__diagnostic-check{border-top:1px solid var(--dsw-alias-border-subtle,#e1e5eb)}.dsh-mobile-control__diagnostic-marker{position:relative;width:26px;height:26px;border-radius:50%;background:#edf1f5;color:var(--dsh-diagnostic-info)}.dsh-mobile-control__diagnostic-marker::before,.dsh-mobile-control__diagnostic-marker::after{position:absolute;content:""}.dsh-mobile-control__diagnostic-check.is-ok .dsh-mobile-control__diagnostic-marker{background:#e6f7f0;color:var(--dsh-diagnostic-ok)}.dsh-mobile-control__diagnostic-check.is-ok .dsh-mobile-control__diagnostic-marker::before{top:7px;left:7px;width:9px;height:5px;border-bottom:1.8px solid currentColor;border-left:1.8px solid currentColor;transform:rotate(-45deg)}.dsh-mobile-control__diagnostic-check.is-warning .dsh-mobile-control__diagnostic-marker{background:#fff4dc;color:var(--dsh-diagnostic-warning)}.dsh-mobile-control__diagnostic-check.is-error .dsh-mobile-control__diagnostic-marker{background:#fdecec;color:var(--dsh-diagnostic-error)}.dsh-mobile-control__diagnostic-check.is-warning .dsh-mobile-control__diagnostic-marker::before,.dsh-mobile-control__diagnostic-check.is-error .dsh-mobile-control__diagnostic-marker::before{top:6px;left:12px;width:2px;height:9px;border-radius:2px;background:currentColor}.dsh-mobile-control__diagnostic-check.is-warning .dsh-mobile-control__diagnostic-marker::after,.dsh-mobile-control__diagnostic-check.is-error .dsh-mobile-control__diagnostic-marker::after{bottom:6px;left:12px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-mobile-control__diagnostic-check.is-info .dsh-mobile-control__diagnostic-marker::before{top:6px;left:12px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-mobile-control__diagnostic-check.is-info .dsh-mobile-control__diagnostic-marker::after{top:10px;left:12px;width:2px;height:9px;border-radius:2px;background:currentColor}.dsh-mobile-control__diagnostic-check-body{min-width:0}.dsh-mobile-control__diagnostic-check-header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.dsh-mobile-control__diagnostic-check-header strong{min-width:0;font-size:12px;line-height:1.4}.dsh-mobile-control__diagnostic-badge{flex:none;padding:2px 6px;border-radius:999px;background:#edf1f5;color:var(--dsh-diagnostic-info);font:650 10px/1.3 system-ui}.dsh-mobile-control__diagnostic-check.is-ok .dsh-mobile-control__diagnostic-badge{background:#e6f7f0;color:var(--dsh-diagnostic-ok)}.dsh-mobile-control__diagnostic-check.is-warning .dsh-mobile-control__diagnostic-badge{background:#fff4dc;color:var(--dsh-diagnostic-warning)}.dsh-mobile-control__diagnostic-check.is-error .dsh-mobile-control__diagnostic-badge{background:#fdecec;color:var(--dsh-diagnostic-error)}.dsh-mobile-control__diagnostic-check p{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5;overflow-wrap:anywhere}.dsh-mobile-control__diagnostic-check .dsh-mobile-control__diagnostic-action{margin-top:7px;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#f8fafc);color:var(--dsw-alias-label-primary,#16181d)}.dsh-mobile-control__diagnostic-action span{display:inline-block;margin-right:6px;color:#2563eb;font-weight:700}.dsh-mobile-control__diagnostic-details{margin-top:12px}.dsh-mobile-control__diagnostic-details[hidden]{display:none}.dsh-mobile-control__diagnostic-details>summary{box-sizing:border-box;min-height:44px;line-height:44px}.dsh-mobile-control__diagnostic-report{box-sizing:border-box;max-height:220px;margin:4px 0 0;overflow:auto;padding:10px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#f3f5f8);color:var(--dsw-alias-label-secondary,#606873);font:10px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-mobile-control__diagnostic-checks{transition:opacity 150ms ease}.dsh-mobile-control__diagnostic-checks.is-refreshing{opacity:.52}
@keyframes dsh-diagnostic-spin{to{transform:rotate(360deg)}}@keyframes dsh-diagnostic-reveal{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.dsh-mobile-control__actions{display:flex;flex-wrap:nowrap;gap:6px}.dsh-mobile-control__actions button{flex:1 1 0;min-width:0;min-height:40px;padding:8px 4px;border-radius:10px;font:12px/1.2 system-ui;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsh-mobile-control__secondary{border:1px solid var(--dsw-alias-border-normal,#cfd5dd);background:transparent;color:inherit}.dsh-mobile-control__primary{border:1px solid #2563eb;background:#2563eb;color:#fff}.dsh-mobile-control__actions button:disabled{cursor:not-allowed;opacity:.45}
.dsh-mobile-control button:focus-visible,.dsh-mobile-control a:focus-visible,.dsh-mobile-control input:focus-visible,.dsh-mobile-control summary:focus-visible{outline:3px solid rgb(37 99 235 / 28%);outline-offset:2px}
.dsh-mobile-control__trigger{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:calc(100% + 8px);height:34px;margin:4px -4px;padding:6px 2px 6px 10px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary,#16181d);font:14px/22px system-ui;cursor:pointer}.dsh-mobile-control__trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}.dsh-mobile-control__trigger.is-rail{width:36px;height:36px;margin:8px 0 10px;padding:0;justify-content:center;border-radius:50%}.dsh-mobile-control__trigger-icon{position:relative;box-sizing:border-box;flex:none;width:14px;height:19px;border:1.7px solid currentColor;border-radius:3px}.dsh-mobile-control__trigger-icon::after{position:absolute;right:4px;bottom:2px;width:4px;height:1.5px;border-radius:2px;background:currentColor;content:""}.dsh-mobile-control__trigger-label{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dsh-mobile-control__manage-row{display:flex;justify-content:space-between;gap:8px;margin-top:10px}.dsh-mobile-control__manage{flex:1 1 0;min-width:0;min-height:34px;padding:6px 8px;border:1px solid var(--dsw-alias-border-normal,#cfd5dd);border-radius:10px;background:transparent;color:inherit;font:12px/1.3 system-ui;cursor:pointer}.dsh-mobile-control__devices{margin-top:10px;border:1px solid var(--dsw-alias-border-subtle,#e1e5eb);border-radius:10px;padding:8px;max-height:220px;overflow-y:auto}.dsh-mobile-control__device-empty{color:var(--dsw-alias-label-secondary,#606873);font-size:12px;margin:0}.dsh-mobile-control__device{display:flex;align-items:center;gap:8px;padding:6px 2px}.dsh-mobile-control__device + .dsh-mobile-control__device{border-top:1px solid var(--dsw-alias-border-subtle,#e1e5eb)}.dsh-mobile-control__device-label{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.dsh-mobile-control__device-meta{flex:none;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;white-space:nowrap}.dsh-mobile-control__device-revoke{flex:none;min-height:28px;padding:4px 8px;border:1px solid #dc2626;border-radius:8px;background:transparent;color:#dc2626;font:12px/1.2 system-ui;cursor:pointer}
@media (prefers-reduced-motion:reduce){.dsh-mobile-control__provider,.dsh-mobile-control__cpolar-connect{transition:none}.dsh-mobile-control__diagnostic-summary.is-running .dsh-mobile-control__diagnostic-summary-icon::before,.dsh-mobile-control__diagnostic-checks{animation:none}}
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
    const triggerLocale = selectedMobileControlLocale()
    const t = controlTranslator(triggerLocale)
    const disposeSlot = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register<{ wide: boolean }>({ name: 'sidebar.footer.action', id: 'dsh-mobile' }, ({ wide }) => createElement('button', {
      'aria-expanded': false,
      'aria-label': t('mobileAccess'),
      className: `dsh-mobile-control__trigger${wide ? '' : ' is-rail'}`,
      lang: triggerLocale,
      type: 'button',
      title: t('mobileAccess'),
      onClick: control.toggle,
    }, createElement('span', { 'aria-hidden': true, className: 'dsh-mobile-control__trigger-icon' }), wide ? createElement('span', { className: 'dsh-mobile-control__trigger-label' }, t('mobileAccess')) : undefined)))
    return () => { disposeSlot(); control.remove(); style.remove() }
  }, 'dsh-mobile: stock mobile adaptation and local control')
}

/** Client services required by the mobile adaptation. */
export const inject: readonly string[] = ['slots']
