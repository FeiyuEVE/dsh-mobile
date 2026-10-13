import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { isIP } from 'node:net'
import { isLoopbackAddress, parseAuthority, parseCidr, type AuthoritySpec, type ParsedCidr } from './network.js'

/** TLS source accepted by the LAN listener. */
export interface ProvidedTlsConfig {
  readonly mode: 'provided'
  /** PEM server leaf followed by any intermediate certificate chain. */
  readonly certFile: string
  readonly keyFile: string
  /** Optional PEM intermediates appended after the chain in `certFile`; roots are rejected. */
  readonly caFile?: string
}

/** HTTP is available only for an explicitly loopback-bound listener. */
export interface DisabledTlsConfig {
  readonly mode: 'disabled'
}

export type TlsConfig = ProvidedTlsConfig | DisabledTlsConfig

/** Operator-facing plugin configuration. */
export interface PluginConfig {
  /** Optional setup JSON written by the packaged CLI. */
  setupFile?: string
  /** Preferred HTTPS origin used to derive the public authority and listener port. */
  publicOrigin?: string
  listenHost?: string
  listenPort?: number
  upstreamOrigin?: string
  publicAuthorities?: string[]
  allowedCidrs?: string[]
  /** Opt-in: accept inbound Host/Origin whose hostname is an IP literal on the listener port
   *  (公网 IPv6 直连：SLAAC 地址动态，无法预配进 publicAuthorities)。 */
  allowIpLiteralHosts?: boolean
  stateFile: string
  /**
   * 账号与令牌的存放目录（`account.json` / `tokens.json`）。
   *
   * **三服统一鉴权的关键**：指定同一个目录，正式服 / 测试服（将来还有自救服务）
   * 就共用一份账号与令牌表 —— 在任意一台登录，另一台立刻认这枚 token；在任意一台
   * 撤销，另一台立刻失效。省略 = 沿用 `stateFile` 所在目录（单进程老行为）。
   */
  accountDir?: string
  /**
   * 账号 / 令牌表的文件模式（八进制，默认 `0o600`）。
   *
   * 只有**跨 uid 共用 `accountDir`** 时才需要改：本机形态是自救服务跑 root、
   * 正式服/测试服跑 feiyueve，root 写出的 `account.json`/`tokens.json` 若保持
   * 0600，feiyueve 就读不到。配 `0o640` 并让目录 setgid 到共享组（新文件继承组）
   * 即可；读方 chmod 失败被容忍（见 `private-file.ts`），不会再让网关起不来。
   *
   * 只接受 `0o600` / `0o620` / `0o640` / `0o660`：属主 rw 必选，共享组可选 r/w，
   * **永不**对 other 开口。比 0600 松是**故意**的（跨 uid 共享就靠组位），但账号表
   * 一旦其他人可写，等于谁都能给自己签一枚 token——那正是这条白名单要挡的。
   */
  accountFileMode?: number
  /** Internal persisted on/off preference managed by the DSH plugin card. */
  controlFile: string
  /** Optional user stylesheet served to the authenticated mobile UI. */
  customCssFile?: string
  /** Optional user script that mounts authenticated mobile-only Web features. */
  customScriptFile?: string
  /** Internal dedicated mobile layout browser bundle. */
  mobileLayoutFile?: string
  /**
   * **内容热更**的页面资源目录（`manifest.json` + 逻辑名文件树）。
   *
   * App 的 Dart 侧（`../dsh-mobile-flutter` 的 `RemoteAssets`）从这里取
   * `/mobile-access/app-assets/*`；发布脚本把 App 的 `assets/` 快照写进来即可，
   * 目录不存在就是「没有热更内容」（一律 404，App 回落内置）。
   *
   * 省略 = `accountDir/hotupdate`：与账号表同一处，于是**三服共用同一份热更内容**
   * （在 web 上发布，staging/rescue 立刻也是这一版）。
   */
  hotUpdateDir?: string
  /**
   * **Dart 补丁**目录（`index.json` + `*.bin`）。
   *
   * 目录里放的是发布脚本写出的清单与补丁字节（见 `src/hot-update.ts` 顶部）；网关按
   * 设备端协议现算应答，**不依赖任何常驻服务**。省略 = `accountDir/codepush`。
   */
  codePushDir?: string
  /**
   * Opt-in Service Worker static caching for the mobile page. When enabled the
   * rewritten mobile index registers a gateway-scoped worker that serves
   * revisioned plugin/assets/mobile-boot responses from Cache Storage, so page
   * entry no longer depends on the WebView engine's HTTP disk cache.
   */
  staticCacheWorker?: boolean
  /** Stable public discovery identifier; it is not an authentication secret. */
  instanceId?: string
  /** Managed CA certificate offered to the Android installer after fingerprint binding. */
  pairingCaFile?: string
  /** First-run state used only while the control file does not exist. */
  initiallyEnabled: boolean
  tls?: {
    mode?: 'provided' | 'disabled'
    certFile?: string
    keyFile?: string
    caFile?: string
  }
  pairingTtlMs?: number
  deviceTtlMs?: number
  sessionTtlMs?: number
  maxDevices?: number
  maxSessions?: number
  maxConnections?: number
  maxActiveRequests?: number
  maxWebSockets?: number
  maxBodyBytes?: number
  upstreamTimeoutMs?: number
  rateLimitWindowMs?: number
  maxPairingAttempts?: number
  maxRateLimitKeys?: number
}

/** Resolved, validated security and resource limits. */
export interface ResolvedGatewayConfig {
  readonly listenHost: string
  readonly listenPort: number
  readonly upstreamOrigin: URL
  readonly authorities: readonly AuthoritySpec[]
  readonly allowedCidrs: readonly ParsedCidr[]
  readonly allowIpLiteralHosts: boolean
  readonly stateFile: string
  /**
   * 账号 / 令牌目录（见 raw 配置的 `accountDir`）。
   *
   * 多进程共用同一目录时，`AccountController` 会用它放跨进程锁（`.account.lock`）
   * 并在授权热路径上按文件指纹同步刷新。
   */
  readonly accountDir: string
  /** 账号 / 令牌表的落盘模式（见 raw 配置的 `accountFileMode`）。 */
  readonly accountFileMode: number
  /** Local extension root adjacent to the mobile-access state file. */
  readonly extensionsDir: string
  readonly customCssFile: string
  readonly customScriptFile: string
  readonly mobileLayoutFile: string
  /** 内容热更的页面资源目录（见 raw 配置的 `hotUpdateDir`）。 */
  readonly hotUpdateDir: string
  /** Dart 补丁目录（见 raw 配置的 `codePushDir`）。 */
  readonly codePushDir: string
  /** Whether the mobile page registers the Service Worker static cache. */
  readonly staticCacheWorker: boolean
  readonly instanceId: string
  readonly pairingCaFile?: string
  readonly tls: TlsConfig
  /** Whether the public hop is HTTPS, even when a trusted loopback proxy terminates TLS. */
  readonly publicTls: boolean
  /** LAN discovery is disabled for private proxy listeners such as Funnel ingress. */
  readonly discovery: boolean
  readonly pairingTtlMs: number
  readonly deviceTtlMs: number
  readonly sessionTtlMs: number
  readonly maxDevices: number
  readonly maxSessions: number
  readonly maxConnections: number
  readonly maxActiveRequests: number
  readonly maxWebSockets: number
  readonly maxBodyBytes: number
  readonly upstreamTimeoutMs: number
  readonly rateLimitWindowMs: number
  readonly maxPairingAttempts: number
  readonly maxRateLimitKeys: number
}

/** Loader-facing defaults; {@link parseGatewayConfig} enforces cross-field security rules. */
export const Config: z<PluginConfig> = z.object({
  setupFile: z.string().hidden(),
  publicOrigin: z.string(),
  listenHost: z.string(),
  listenPort: z.natural().max(65535),
  upstreamOrigin: z.string(),
  publicAuthorities: z.array(String).default(undefined as unknown as string[]),
  allowedCidrs: z.array(String).default(undefined as unknown as string[]),
  allowIpLiteralHosts: z.boolean().default(false),
  stateFile: String,
  controlFile: z.string().hidden().required(),
  customCssFile: z.string().hidden(),
  customScriptFile: z.string().hidden(),
  mobileLayoutFile: z.string().hidden(),
  hotUpdateDir: z.string().hidden(),
  codePushDir: z.string().hidden(),
  staticCacheWorker: z.boolean(),
  instanceId: z.string().hidden(),
  pairingCaFile: z.string().hidden(),
  initiallyEnabled: z.boolean().hidden().required(),
  tls: z.object({
    mode: z.union([z.const('provided'), z.const('disabled')]),
    certFile: z.string(),
    keyFile: z.string(),
    caFile: z.string(),
  }),
  pairingTtlMs: z.natural(),
  deviceTtlMs: z.natural(),
  sessionTtlMs: z.natural(),
  maxDevices: z.natural(),
  maxSessions: z.natural(),
  maxConnections: z.natural(),
  maxActiveRequests: z.natural(),
  maxWebSockets: z.natural(),
  maxBodyBytes: z.natural(),
  upstreamTimeoutMs: z.natural(),
  rateLimitWindowMs: z.natural(),
  maxPairingAttempts: z.natural(),
  maxRateLimitKeys: z.natural(),
})

function integer(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} must be an integer from ${String(minimum)} through ${String(maximum)}`)
  }
  return resolved
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`${name} must be a non-empty string array`)
  }
  return value as string[]
}

function absoluteFile(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute file path`)
  }
  return resolve(value)
}

/** Resolve the hidden runtime-control file independently from gateway configuration. */
export function parseControlFile(value: unknown): string {
  return absoluteFile(value, 'controlFile')
}

/** 允许的落盘模式白名单（见 [parseAccountFileMode]）。 */
const ACCOUNT_FILE_MODES: ReadonlySet<number> = new Set([0o600, 0o620, 0o640, 0o660])

/**
 * 账号 / 令牌表的落盘模式（`accountFileMode`，默认 `0o600`）。
 *
 * YAML 里写 `0o640` 这种八进制字面量：**十进制 `640`（本想写 0640 的常见误写）会被
 * 这条白名单拒掉并报错**，写错就当场炸、不会悄悄落一个谁都没预期的模式。
 * 白名单只有四个值：属主 rw 必选（没有它写方都读不回自己的表），共享组 r/w 可选
 * （跨 uid 共用账号目录的正当需求：自救服务 root 写、正式服/测试服 feiyueve 读），
 * **other 位一律不许**——账号表是凭据权威，对 other 可写 = 任何人能给自己签 token，
 * 对 other 可读 = 密码 scrypt 摘要与 token 摘要外泄。
 */
export function parseAccountFileMode(value: unknown): number {
  if (value === undefined) return 0o600
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('accountFileMode must be an integer file mode such as 0o640')
  }
  if (!ACCOUNT_FILE_MODES.has(value)) {
    throw new Error(
      'accountFileMode must be one of 0o600, 0o620, 0o640, 0o660 '
      + '(owner read/write, optional shared-group read/write, never other)',
    )
  }
  return value
}

function parseUpstream(value: unknown): URL {
  const source = value ?? 'http://127.0.0.1:3080'
  if (typeof source !== 'string') throw new Error('upstreamOrigin must be a string')
  let url: URL
  try {
    url = new URL(source)
  } catch {
    throw new Error('upstreamOrigin must be an HTTP loopback origin')
  }
  if (url.protocol !== 'http:' || !isLoopbackAddress(url.hostname) || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.port === '') {
    throw new Error('upstreamOrigin must be an HTTP loopback origin with an explicit port and no path or credentials')
  }
  return url
}

function parsePublicOrigin(value: unknown): { readonly authority: AuthoritySpec; readonly port: number } | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error('publicOrigin must be an HTTPS origin')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('publicOrigin must be an HTTPS origin')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('publicOrigin must be an HTTPS origin with no path or credentials')
  }
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') {
    throw new Error('publicOrigin must name a reachable host')
  }
  return Object.freeze({
    authority: parseAuthority(url.host),
    port: Number(url.port || '443'),
  })
}

function parseTls(value: PluginConfig['tls'], listenHost: string): TlsConfig {
  const mode = value?.mode ?? 'provided'
  if (mode === 'disabled') {
    if (!isLoopbackAddress(listenHost)) throw new Error('TLS may be disabled only on an IP loopback listener')
    return Object.freeze({ mode })
  }
  return Object.freeze({
    mode,
    certFile: absoluteFile(value?.certFile, 'tls.certFile'),
    keyFile: absoluteFile(value?.keyFile, 'tls.keyFile'),
    ...(value?.caFile === undefined ? {} : { caFile: absoluteFile(value.caFile, 'tls.caFile') }),
  })
}

/** Parse configuration and reject unsafe topology, credential, and resource combinations. */
export function parseGatewayConfig(raw: unknown): ResolvedGatewayConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('mobile-access config must be an object')
  const value = raw as PluginConfig
  const publicOrigin = parsePublicOrigin(value.publicOrigin)
  if (publicOrigin !== undefined && value.listenPort !== undefined) {
    throw new Error('publicOrigin cannot be combined with listenPort')
  }
  if (publicOrigin !== undefined && value.publicAuthorities !== undefined) {
    throw new Error('publicOrigin cannot be combined with publicAuthorities')
  }
  const listenHost = value.listenHost ?? (publicOrigin === undefined ? '127.0.0.1' : '0.0.0.0')
  if (isIP(listenHost) === 0) throw new Error('listenHost must be an IP literal')
  const listenPort = publicOrigin?.port ?? integer(value.listenPort, 'listenPort', 3443, 0, 65535)
  const upstreamOrigin = parseUpstream(value.upstreamOrigin)
  const tls = parseTls(value.tls, listenHost)
  if (publicOrigin !== undefined && tls.mode !== 'provided') {
    throw new Error('publicOrigin requires TLS')
  }

  let authorities: AuthoritySpec[]
  if (publicOrigin !== undefined) {
    authorities = [publicOrigin.authority]
  } else {
    let authoritySources = value.publicAuthorities
    if (authoritySources === undefined || authoritySources.length === 0) {
      if (!isLoopbackAddress(listenHost)) throw new Error('publicAuthorities is required for a non-loopback listener')
      authoritySources = [listenHost]
    }
    authorities = authoritySources.map(parseAuthority)
  }
  for (const authority of authorities) {
    if (listenPort === 0 && authority.port !== undefined) {
      throw new Error('explicit public authority ports require a non-zero listenPort')
    }
    if (authority.port !== undefined && listenPort !== 0 && authority.port !== listenPort) {
      throw new Error('every explicit public authority port must equal listenPort')
    }
  }
  if (new Set(authorities.map(entry => `${entry.hostname}:${String(entry.port ?? listenPort)}`)).size !== authorities.length) {
    throw new Error('publicAuthorities must not contain duplicates')
  }

  const cidrSources = value.allowedCidrs
    ?? (isLoopbackAddress(listenHost) ? ['127.0.0.0/8', '::1/128'] : undefined)
  const allowedCidrs = stringArray(cidrSources, 'allowedCidrs').map(parseCidr)
  if (new Set(allowedCidrs.map(entry => `${String(entry.bits)}:${entry.network.toString(16)}:${String(entry.prefix)}`)).size !== allowedCidrs.length) {
    throw new Error('allowedCidrs must not contain duplicates')
  }
  const deviceTtlMs = integer(value.deviceTtlMs, 'deviceTtlMs', 90 * 24 * 60 * 60_000, 60_000, 366 * 24 * 60 * 60_000)
  const sessionTtlMs = integer(value.sessionTtlMs, 'sessionTtlMs', 8 * 60 * 60_000, 30_000, 24 * 60 * 60_000)
  if (sessionTtlMs > deviceTtlMs) throw new Error('sessionTtlMs must not exceed deviceTtlMs')

  const stateFile = absoluteFile(value.stateFile, 'stateFile')
  const accountDir = value.accountDir === undefined ? dirname(stateFile) : absoluteFile(value.accountDir, 'accountDir')

  return Object.freeze({
    listenHost,
    listenPort,
    upstreamOrigin,
    authorities: Object.freeze(authorities),
    allowedCidrs: Object.freeze(allowedCidrs),
    allowIpLiteralHosts: value.allowIpLiteralHosts ?? false,
    stateFile,
    accountDir,
    accountFileMode: parseAccountFileMode(value.accountFileMode),
    extensionsDir: join(dirname(stateFile), 'extensions'),
    customCssFile: value.customCssFile === undefined
      ? join(dirname(stateFile), 'mobile.css')
      : absoluteFile(value.customCssFile, 'customCssFile'),
    customScriptFile: value.customScriptFile === undefined
      ? join(dirname(stateFile), 'mobile.js')
      : absoluteFile(value.customScriptFile, 'customScriptFile'),
    mobileLayoutFile: value.mobileLayoutFile === undefined
      ? fileURLToPath(new URL('./mobile-layout.js', import.meta.url))
      : absoluteFile(value.mobileLayoutFile, 'mobileLayoutFile'),
    hotUpdateDir: value.hotUpdateDir === undefined
      ? join(accountDir, 'hotupdate')
      : absoluteFile(value.hotUpdateDir, 'hotUpdateDir'),
    codePushDir: value.codePushDir === undefined
      ? join(accountDir, 'codepush')
      : absoluteFile(value.codePushDir, 'codePushDir'),
    staticCacheWorker: value.staticCacheWorker === true,
    instanceId: value.instanceId === undefined
      ? createHash('sha256').update(stateFile).digest('hex')
      : /^[a-f\d]{64}$/u.test(value.instanceId)
        ? value.instanceId
        : (() => { throw new Error('instanceId must be a lowercase SHA-256 value') })(),
    ...(value.pairingCaFile === undefined ? {} : { pairingCaFile: absoluteFile(value.pairingCaFile, 'pairingCaFile') }),
    tls,
    publicTls: tls.mode === 'provided',
    discovery: true,
    pairingTtlMs: integer(value.pairingTtlMs, 'pairingTtlMs', 120_000, 10_000, 600_000),
    deviceTtlMs,
    sessionTtlMs,
    maxDevices: integer(value.maxDevices, 'maxDevices', 32, 1, 256),
    maxSessions: integer(value.maxSessions, 'maxSessions', 64, 1, 1024),
    maxConnections: integer(value.maxConnections, 'maxConnections', 64, 1, 1024),
    maxActiveRequests: integer(value.maxActiveRequests, 'maxActiveRequests', 32, 1, 1024),
    maxWebSockets: integer(value.maxWebSockets, 'maxWebSockets', 16, 1, 256),
    maxBodyBytes: integer(value.maxBodyBytes, 'maxBodyBytes', 160 * 1024 * 1024, 1024, 256 * 1024 * 1024),
    upstreamTimeoutMs: integer(value.upstreamTimeoutMs, 'upstreamTimeoutMs', 30_000, 1_000, 300_000),
    rateLimitWindowMs: integer(value.rateLimitWindowMs, 'rateLimitWindowMs', 60_000, 1_000, 3_600_000),
    maxPairingAttempts: integer(value.maxPairingAttempts, 'maxPairingAttempts', 8, 1, 100),
    maxRateLimitKeys: integer(value.maxRateLimitKeys, 'maxRateLimitKeys', 256, 1, 4096),
  })
}
