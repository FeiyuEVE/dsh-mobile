import { createHash, X509Certificate } from 'node:crypto'
import { createSocket, type Socket as DatagramSocket } from 'node:dgram'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import {
  createServer as createHttpServer,
  request as requestHttp,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer, type ServerOptions } from 'node:https'
import { connect, isIP, type AddressInfo, type Socket } from 'node:net'
import { Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import Bonjour from 'bonjour-service'
import {
  AccessController,
  AccessError,
  BoundedRateLimiter,
  type DeviceSummary,
  type SessionAuthorization,
} from './access.js'
import type { ResolvedGatewayConfig } from './config.js'
import {
  AUTH_PREFIX,
  assertExternalTrust,
  assertLocalAdminTrust,
  cookie,
  CSRF_COOKIE,
  CSRF_HEADER,
  DEVICE_COOKIE,
  HttpError,
  LOCAL_ADMIN_PREFIX,
  parseCookies,
  parseRequestTarget,
  readJsonObject,
  sendFailure,
  sendJson,
  SESSION_COOKIE,
  setSecurityHeaders,
  WS_PATHS,
} from './http-security.js'
import { addressAllowed, type ParsedCidr, RequestTrustPolicy } from './network.js'
import type { DeviceStore } from './storage.js'
import { listComputerImages, readComputerImage } from './computer-images.js'

type GatewayServer = HttpServer | HttpsServer

interface ActiveRequest {
  readonly sessionKey: string
  readonly deviceId: string
  readonly expiresAt: number
  readonly abort: () => void
  readonly timer: NodeJS.Timeout
}

interface ActiveWebSocket {
  readonly sessionKey: string
  readonly deviceId: string
  readonly client: Socket
  readonly upstream: Socket
  readonly timer: NodeJS.Timeout
}

const MAX_CONTROL_BODY_BYTES = 16 * 1024
const MAX_HEADER_BYTES = 16 * 1024
const DISCOVERY_QUERY = Buffer.from('DSH_MOBILE_DISCOVER_V1', 'ascii')
const DISCOVERY_PROTOCOL = 1
const DISCOVERY_INTERVAL_MS = 3_000
const MDNS_SERVICE_TYPE = 'dsh-mobile'
const MOBILE_LAYOUT_MODULE = '@deepseek-ai/dsh-client-ui-layout'
const MOBILE_LAYOUT_PATH = `${AUTH_PREFIX}/mobile-layout.js`
const MOBILE_LAYOUT_DEPENDENCIES = Object.freeze([
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-theme',
])
const PAIR_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Pair DSH mobile access</title>
<main>
  <h1>Pair this device</h1>
  <form id="pair-form">
    <label>Pairing code <input id="pair-token" autocomplete="one-time-code" required></label>
    <label>Device name <input id="device-label" maxlength="64" autocomplete="off"></label>
    <button type="submit">Pair</button>
    <output id="pair-status"></output>
  </form>
</main>
<script src="/mobile-access/pair.js" defer></script>
</html>
`

interface BootGraphEntry {
  id: string
  url: string
  rev: string
  inject?: string[]
  immediately?: boolean
}

/** Replace only DSH's layout client module while retaining its complete plugin graph. */
export function rewriteMobileIndex(html: string): string {
  const assignment = 'window.__DSH_BOOT__ = '
  const start = html.indexOf(assignment)
  if (start < 0) throw new Error('upstream DSH index has no boot manifest')
  const valueStart = start + assignment.length
  const scriptEnd = html.indexOf('</script>', valueStart)
  if (scriptEnd < 0) throw new Error('upstream DSH boot manifest script is incomplete')
  const source = html.slice(valueStart, scriptEnd).trim().replace(/;$/u, '')
  const parsed = JSON.parse(source) as { rev?: unknown; entries?: unknown }
  if (typeof parsed.rev !== 'string' || !Array.isArray(parsed.entries)) {
    throw new Error('upstream DSH boot manifest is malformed')
  }
  const entries = parsed.entries as BootGraphEntry[]
  const layout = entries.filter(entry => entry !== null && typeof entry === 'object' && entry.id === MOBILE_LAYOUT_MODULE)
  if (layout.length !== 1 || typeof layout[0]?.url !== 'string' || typeof layout[0].rev !== 'string') {
    throw new Error('upstream DSH boot manifest has no unique layout module')
  }
  if (!Array.isArray(layout[0].inject)
    || MOBILE_LAYOUT_DEPENDENCIES.some(dependency => !layout[0]?.inject?.includes(dependency))) {
    throw new Error('upstream DSH layout module has unsupported dependencies')
  }
  layout[0].url = MOBILE_LAYOUT_PATH
  layout[0].rev = 'dsh-mobile-layout-v1'
  const replacement = `window.__DSH_MOBILE_FRONTEND__="dedicated";${assignment}${JSON.stringify(parsed)};`
  return `${html.slice(0, start)}${replacement}${html.slice(scriptEnd)}`
}

const PAIR_SCRIPT = `(() => {
  const form = document.getElementById('pair-form')
  const token = document.getElementById('pair-token')
  const label = document.getElementById('device-label')
  const status = document.getElementById('pair-status')
  const fragment = new URLSearchParams(location.hash.slice(1))
  const supplied = fragment.get('token')
  history.replaceState(null, '', location.pathname)
  if (supplied) token.value = supplied
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    status.value = 'Pairing…'
    const response = await fetch('/mobile-access/auth/pair', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token.value, label: label.value || undefined }),
    })
    if (!response.ok) {
      status.value = 'Pairing failed'
      return
    }
    location.replace('/')
  })
})()
`

const LOGIN_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Reconnect DSH mobile access</title>
<main>
  <h1>Reconnect this device</h1>
  <p id="login-progress">Restoring the secure Session…</p>
  <section id="login-failed" hidden>
    <p>This device is no longer paired. Open pairing on the computer, then pair it again.</p>
    <a href="/mobile-access/pair">Open pairing</a>
  </section>
</main>
<script src="/mobile-access/login.js" defer></script>
</html>
`

const LOGIN_SCRIPT = `(() => {
  const candidate = new URL(location.href).searchParams.get('return')
  let returnPath = '/'
  if (candidate && candidate.startsWith('/')) {
    try {
      const resolved = new URL(candidate, location.origin)
      const pathname = decodeURIComponent(resolved.pathname)
      if (resolved.origin === location.origin && pathname !== '/mobile-access'
        && !pathname.startsWith('/mobile-access/') && !pathname.includes('\\\\')) {
        returnPath = resolved.pathname + resolved.search + resolved.hash
      }
    } catch {
      // Malformed untrusted return targets keep the safe root default.
    }
  }
  fetch('/mobile-access/auth/renew', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).then((response) => {
    if (response.ok) {
      location.replace(returnPath)
      return
    }
    document.getElementById('login-progress').hidden = true
    document.getElementById('login-failed').hidden = false
  }).catch(() => {
    document.getElementById('login-progress').textContent = 'The computer is unavailable.'
  })
})()
`

class ByteLimitTransform extends Transform {
  private total = 0

  constructor(private readonly maximum: number) {
    super()
  }

  override _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
    this.total += buffer.length
    if (this.total > this.maximum) {
      callback(new HttpError(413, 'payload_too_large'))
      return
    }
    callback(null, buffer)
  }
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

interface PemCertificate {
  readonly pem: string
  readonly certificate: X509Certificate
}

function parsePemCertificates(contents: Buffer, source: string): PemCertificate[] {
  const text = contents.toString('utf8')
  const pattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu
  const blocks = text.match(pattern) ?? []
  if (blocks.length === 0 || text.replace(pattern, '').trim() !== '') {
    throw new Error(`${source} must contain only PEM certificates`)
  }
  return blocks.map((pem) => {
    let certificate: X509Certificate
    try {
      certificate = new X509Certificate(pem)
    } catch (error) {
      throw new Error(`${source} contains an invalid certificate`, { cause: error })
    }
    return Object.freeze({ pem: `${pem}\n`, certificate })
  })
}

function validateServerChain(chain: readonly PemCertificate[]): void {
  const now = Date.now()
  for (const [index, entry] of chain.entries()) {
    if (Date.parse(entry.certificate.validFrom) > now || Date.parse(entry.certificate.validTo) <= now) {
      throw new Error('TLS certificate chain contains a certificate that is not currently valid')
    }
    if (index === 0) continue
    if (entry.certificate.subject === entry.certificate.issuer
      && entry.certificate.verify(entry.certificate.publicKey)) {
      throw new Error('TLS server certificate chain must not include a self-signed root')
    }
    const child = chain[index - 1]!.certificate
    if (!entry.certificate.ca || !child.checkIssued(entry.certificate)
      || !child.verify(entry.certificate.publicKey)) {
      throw new Error('TLS server certificate chain is not an ordered leaf-to-intermediate chain')
    }
  }
}

async function tlsOptions(config: ResolvedGatewayConfig): Promise<ServerOptions> {
  if (config.tls.mode === 'disabled') throw new Error('TLS options requested for a disabled listener')
  const [certFile, key, additionalChainFile] = await Promise.all([
    readFile(config.tls.certFile),
    readFile(config.tls.keyFile),
    config.tls.caFile === undefined ? Promise.resolve(undefined) : readFile(config.tls.caFile),
  ])
  const chain = [
    ...parsePemCertificates(certFile, 'tls.certFile'),
    ...(additionalChainFile === undefined ? [] : parsePemCertificates(additionalChainFile, 'tls.caFile')),
  ]
  validateServerChain(chain)
  const leaf = chain[0]!.certificate
  for (const authority of config.authorities) {
    const hostname = stripIpv6Brackets(authority.hostname)
    const match = isIP(hostname) === 0 ? leaf.checkHost(hostname) : leaf.checkIP(hostname)
    if (match === undefined) throw new Error(`TLS certificate does not cover configured authority ${hostname}`)
  }
  return {
    cert: chain.map(entry => entry.pem).join(''),
    key,
    requestCert: false,
    minVersion: 'TLSv1.2',
    maxHeaderSize: MAX_HEADER_BYTES,
  }
}

function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'ascii').digest('base64')
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? undefined : value
}

function hasToken(header: string | undefined, token: string): boolean {
  return header?.split(',').some(value => value.trim().toLowerCase() === token) ?? false
}

function rejectUpgrade(socket: Socket, status: number, code: string): void {
  if (socket.destroyed) return
  const body = `${JSON.stringify({ error: code })}\n`
  socket.end([
    `HTTP/1.1 ${String(status)} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Request'}`,
    'Connection: close',
    'Cache-Control: no-store',
    'Content-Type: application/json; charset=utf-8',
    'Referrer-Policy: no-referrer',
    'X-Content-Type-Options: nosniff',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}

function sanitizeRequestHeaders(
  request: IncomingMessage,
  upstream: URL,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {
    host: upstream.host,
  }
  if (request.headers.origin !== undefined) headers.origin = upstream.origin
  if (request.headers['sec-fetch-site'] !== undefined) headers['sec-fetch-site'] = 'same-origin'
  const allowed = [
    'accept', 'accept-encoding', 'accept-language', 'content-encoding', 'content-length', 'content-type',
    'if-match', 'if-modified-since', 'if-none-match', 'if-unmodified-since', 'range', 'user-agent',
  ] as const
  for (const name of allowed) {
    const value = request.headers[name]
    if (value !== undefined) headers[name] = value
  }
  return headers
}

const BLOCKED_RESPONSE_HEADERS = new Set([
  'alt-svc', 'cache-control', 'connection', 'content-security-policy', 'content-security-policy-report-only',
  'cross-origin-embedder-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'expires',
  'keep-alive', 'nel', 'permissions-policy', 'pragma', 'proxy-authenticate', 'referrer-policy',
  'report-to', 'reporting-endpoints', 'server', 'set-cookie', 'strict-transport-security', 'trailer',
  'transfer-encoding', 'upgrade', 'via', 'x-content-type-options', 'x-frame-options', 'x-powered-by',
])

function sanitizeResponseHeaders(headers: IncomingHttpHeaders, upstream: URL): OutgoingHttpHeaders {
  const clean: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (value === undefined || BLOCKED_RESPONSE_HEADERS.has(lower) || lower.startsWith('access-control-')) continue
    if (lower === 'location' && typeof value === 'string') {
      try {
        const location = new URL(value, upstream)
        clean.location = location.origin === upstream.origin
          ? `${location.pathname}${location.search}${location.hash}`
          : value
      } catch {
        continue
      }
      continue
    }
    clean[lower] = value
  }
  return clean
}

function requestCookies(request: IncomingMessage): ReadonlyMap<string, string> {
  const cookies = parseCookies(request.headers.cookie)
  if (cookies === undefined) throw new HttpError(401, 'authentication_failed')
  return cookies
}

function mapError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (error instanceof AccessError) return new HttpError(error.status, error.code)
  return new HttpError(500, 'internal_error')
}

function discoveryDeviceName(): string {
  const value = hostname().trim().replaceAll(/[\u0000-\u001f\u007f]/gu, '')
  return (value === '' ? 'DeepSeek Harness' : value).slice(0, 63)
}

function discoveryMdnsHost(instanceId: string): string {
  const label = hostname().toLowerCase().replaceAll(/[^a-z0-9-]/gu, '-').replaceAll(/^-+|-+$/gu, '').slice(0, 40)
  return `${label === '' ? 'dsh' : label}-${instanceId.slice(0, 8)}.local`
}

function discoveryBroadcastTargets(cidrs: readonly ParsedCidr[]): readonly string[] {
  const targets = new Set<string>(['255.255.255.255'])
  for (const cidr of cidrs) {
    if (cidr.bits !== 32 || cidr.prefix >= 32) continue
    const hostBits = BigInt(32 - cidr.prefix)
    const broadcast = cidr.network | ((1n << hostBits) - 1n)
    targets.add([24n, 16n, 8n, 0n].map(shift => Number((broadcast >> shift) & 0xffn)).join('.'))
  }
  return [...targets]
}

/** Authenticated TLS edge in front of the ordinary loopback-only DSH Web server. */
export class MobileAccessGateway {
  readonly access: AccessController
  private readonly tlsEnabled: boolean
  private policy: RequestTrustPolicy | undefined
  private server: GatewayServer | undefined
  private discoverySocket: DatagramSocket | undefined
  private discoveryTimer: NodeJS.Timeout | undefined
  private bonjour: Bonjour | undefined
  private pairingCaCertificate: string | undefined
  private listenerPort: number | undefined
  private readonly connectedSockets = new Set<Socket>()
  private readonly activeRequests = new Map<number, ActiveRequest>()
  private readonly activeWebSockets = new Map<number, ActiveWebSocket>()
  private nextOperationId = 1
  private closing = false
  private started = false
  private closeTask: Promise<void> | undefined
  private readonly removeSessionListener: () => void
  private readonly renewLimiter: BoundedRateLimiter

  constructor(readonly config: ResolvedGatewayConfig, store: DeviceStore) {
    this.tlsEnabled = config.tls.mode === 'provided'
    this.access = new AccessController(store, {
      pairingTtlMs: config.pairingTtlMs,
      deviceTtlMs: config.deviceTtlMs,
      sessionTtlMs: config.sessionTtlMs,
      maxDevices: config.maxDevices,
      maxSessions: config.maxSessions,
      rateLimitWindowMs: config.rateLimitWindowMs,
      maxPairingAttempts: config.maxPairingAttempts,
      maxRateLimitKeys: config.maxRateLimitKeys,
    })
    this.renewLimiter = new BoundedRateLimiter(
      Math.min(100, config.maxPairingAttempts * 4),
      config.rateLimitWindowMs,
      config.maxRateLimitKeys,
    )
    this.removeSessionListener = this.access.onSessionEnded(authorization => {
      this.abortSessionResources(authorization.sessionKey)
    })
  }

  /** Initialize durable state, validate TLS, and bind the externally reachable listener. */
  async start(): Promise<void> {
    if (this.started || this.server !== undefined) throw new Error('mobile-access gateway cannot be started twice')
    this.started = true
    await this.access.initialize()
    try {
      if (this.config.pairingCaFile !== undefined) {
        const certificate = new X509Certificate(await readFile(this.config.pairingCaFile))
        const fingerprint = certificate.fingerprint256.replaceAll(':', '').toLowerCase()
        if (!certificate.ca || certificate.subject !== certificate.issuer
          || !certificate.verify(certificate.publicKey) || fingerprint !== this.config.instanceId) {
          throw new Error('pairingCaFile must be the self-signed CA identified by instanceId')
        }
        this.pairingCaCertificate = certificate.raw.toString('base64')
      }
      const handler = (request: IncomingMessage, response: ServerResponse): void => {
        void this.handleExternalRequest(request, response).catch((error: unknown) => {
          const mapped = mapError(error)
          if (response.headersSent) response.destroy()
          else sendFailure(response, mapped.status, mapped.code, this.tlsEnabled)
        })
      }
      const server = this.tlsEnabled
        ? createHttpsServer(await tlsOptions(this.config), handler)
        : createHttpServer({ maxHeaderSize: MAX_HEADER_BYTES }, handler)
      this.server = server
      server.maxHeadersCount = 64
      server.maxConnections = this.config.maxConnections
      server.headersTimeout = 10_000
      server.requestTimeout = this.config.upstreamTimeoutMs
      server.keepAliveTimeout = 5_000
      server.on('connection', (socket: Socket) => {
        if (this.connectedSockets.size >= this.config.maxConnections) {
          socket.destroy()
          return
        }
        this.connectedSockets.add(socket)
        socket.once('close', () => { this.connectedSockets.delete(socket) })
      })
      server.on('connect', (_request, socket) => { socket.destroy() })
      server.on('upgrade', (request, socket, head) => {
        void this.handleUpgrade(request, socket as Socket, head).catch((error: unknown) => {
          const mapped = mapError(error)
          rejectUpgrade(socket as Socket, mapped.status, mapped.code)
        })
      })
      server.on('clientError', (_error, socket) => { rejectUpgrade(socket as Socket, 400, 'bad_request') })
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => { reject(error) }
        server.once('error', failed)
        server.listen(this.config.listenPort, this.config.listenHost, () => {
          server.off('error', failed)
          resolve()
        })
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('gateway listener has no TCP address')
      this.listenerPort = address.port
      this.policy = new RequestTrustPolicy(
        this.config.authorities,
        address.port,
        this.config.allowedCidrs,
        this.tlsEnabled,
      )
      await this.startDiscovery(address.port)
    } catch (error) {
      await this.closeFailedStart()
      throw error
    }
  }

  private async startDiscovery(port: number): Promise<void> {
    const socket = createSocket('udp4')
    this.discoverySocket = socket
    const announcement = this.discoveryAnnouncement(port)
    socket.on('message', (message, remote) => {
      if (this.closing || !message.equals(DISCOVERY_QUERY)
        || !addressAllowed(remote.address, this.config.allowedCidrs)) return
      socket.send(announcement, remote.port, remote.address, () => undefined)
    })
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => { reject(error) }
      socket.once('error', failed)
      socket.bind(port, '0.0.0.0', () => {
        socket.off('error', failed)
        socket.setBroadcast(true)
        resolve()
      })
    })
    const announce = (): void => {
      for (const target of discoveryBroadcastTargets(this.config.allowedCidrs)) {
        socket.send(announcement, port, target, () => undefined)
      }
    }
    announce()
    this.discoveryTimer = setInterval(announce, DISCOVERY_INTERVAL_MS)
    this.discoveryTimer.unref()

    const deviceName = discoveryDeviceName()
    const bonjour = new Bonjour({ disableIPv6: true })
    this.bonjour = bonjour
    bonjour.publish({
      name: `${deviceName} (${this.config.instanceId.slice(0, 8)})`,
      type: MDNS_SERVICE_TYPE,
      protocol: 'tcp',
      port,
      host: discoveryMdnsHost(this.config.instanceId),
      disableIPv6: true,
      txt: {
        deviceName,
        origin: this.address().origin,
        instanceId: this.config.instanceId,
        protocol: String(DISCOVERY_PROTOCOL),
      },
    })
  }

  private discoveryAnnouncement(port: number): Buffer {
    return Buffer.from(JSON.stringify({
      deviceName: discoveryDeviceName(),
      origin: this.address().origin,
      port,
      protocol: DISCOVERY_PROTOCOL,
      instanceId: this.config.instanceId,
    }), 'utf8')
  }

  private async closeFailedStart(): Promise<void> {
    if (this.discoveryTimer !== undefined) clearInterval(this.discoveryTimer)
    this.discoveryTimer = undefined
    await this.closeBonjour()
    this.discoverySocket?.close()
    this.discoverySocket = undefined
    for (const socket of this.connectedSockets) socket.destroy()
    const server = this.server
    this.server = undefined
    if (server?.listening === true) {
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
    await this.access.close()
  }

  private async closeBonjour(): Promise<void> {
    const bonjour = this.bonjour
    this.bonjour = undefined
    if (bonjour === undefined) return
    await new Promise<void>(resolve => {
      bonjour.unpublishAll(() => { bonjour.destroy(() => resolve()) })
    })
  }

  /** Actual bound address, available after start and safe for loopback status output. */
  address(): { host: string; port: number; origin: string } {
    if (this.listenerPort === undefined || this.policy === undefined) throw new Error('gateway is not listening')
    const origin = this.policy.origins.values().next().value as string | undefined
    if (origin === undefined) throw new Error('gateway has no public authority')
    return Object.freeze({ host: this.config.listenHost, port: this.listenerPort, origin })
  }

  private requirePolicy(): RequestTrustPolicy {
    if (this.policy === undefined || this.closing) throw new HttpError(503, 'unavailable')
    return this.policy
  }

  private authorize(request: IncomingMessage): SessionAuthorization {
    const sessionToken = requestCookies(request).get(SESSION_COOKIE)
    if (sessionToken === undefined) throw new HttpError(401, 'authentication_failed')
    return this.access.authorizeSession(sessionToken)
  }

  private requireCsrf(request: IncomingMessage, authorization: SessionAuthorization): void {
    const value = headerValue(request.headers, CSRF_HEADER)
    this.access.assertCsrf(authorization, value)
  }

  private setSessionCookies(response: ServerResponse, result: {
    sessionToken: string
    csrfToken: string
    sessionExpiresAt: number
  }, now: number): void {
    const maxAge = (result.sessionExpiresAt - now) / 1000
    response.setHeader('Set-Cookie', [
      cookie(SESSION_COOKIE, result.sessionToken, { tls: this.tlsEnabled, httpOnly: true, path: '/', maxAgeSeconds: maxAge }),
      cookie(CSRF_COOKIE, result.csrfToken, { tls: this.tlsEnabled, httpOnly: false, path: '/', maxAgeSeconds: maxAge }),
    ])
  }

  private async handlePair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
    if (typeof body.token !== 'string' || (body.label !== undefined && typeof body.label !== 'string')) {
      throw new HttpError(400, 'bad_request')
    }
    const result = await this.access.pair(request.socket.remoteAddress ?? 'unknown', body.token, body.label as string | undefined)
    const now = Date.now()
    this.setSessionCookies(response, result, now)
    const sessionCookies = response.getHeader('Set-Cookie') as string[]
    response.setHeader('Set-Cookie', [
      ...sessionCookies,
      cookie(DEVICE_COOKIE, result.deviceToken, {
        tls: this.tlsEnabled,
        httpOnly: true,
        path: '/mobile-access/auth/renew',
        maxAgeSeconds: (result.deviceExpiresAt - now) / 1000,
      }),
    ])
    sendJson(response, 201, {
      paired: true,
      deviceId: result.deviceId,
      csrfToken: result.csrfToken,
      sessionExpiresAt: result.sessionExpiresAt,
    }, this.tlsEnabled)
  }

  private async handleRenew(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.renewLimiter.take(request.socket.remoteAddress ?? 'unknown', Date.now())) {
      throw new HttpError(429, 'rate_limited')
    }
    await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
    const deviceToken = requestCookies(request).get(DEVICE_COOKIE)
    if (deviceToken === undefined) throw new HttpError(401, 'authentication_failed')
    let result
    try {
      result = await this.access.renew(deviceToken)
    } catch (error) {
      if (error instanceof AccessError && error.status === 401) {
        response.setHeader('Set-Cookie', cookie(DEVICE_COOKIE, '', {
          tls: this.tlsEnabled,
          httpOnly: true,
          path: '/mobile-access/auth/renew',
          maxAgeSeconds: 0,
        }))
      }
      throw error
    }
    this.setSessionCookies(response, result, Date.now())
    sendJson(response, 200, {
      renewed: true,
      deviceId: result.deviceId,
      csrfToken: result.csrfToken,
      sessionExpiresAt: result.sessionExpiresAt,
    }, this.tlsEnabled)
  }

  private async handleNativePair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
    if (typeof body.token !== 'string' || (body.label !== undefined && typeof body.label !== 'string')) {
      throw new HttpError(400, 'bad_request')
    }
    const result = await this.access.pair(
      request.socket.remoteAddress ?? 'unknown',
      body.token,
      body.label as string | undefined,
    )
    sendJson(response, 201, {
      instanceId: this.config.instanceId,
      deviceId: result.deviceId,
      deviceToken: result.deviceToken,
      deviceExpiresAt: result.deviceExpiresAt,
      sessionToken: result.sessionToken,
      csrfToken: result.csrfToken,
      sessionExpiresAt: result.sessionExpiresAt,
    }, this.tlsEnabled)
  }

  private async handleNativeRenew(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.renewLimiter.take(request.socket.remoteAddress ?? 'unknown', Date.now())) {
      throw new HttpError(429, 'rate_limited')
    }
    const body = await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
    if (typeof body.deviceToken !== 'string') throw new HttpError(400, 'bad_request')
    const result = await this.access.renew(body.deviceToken)
    sendJson(response, 200, {
      instanceId: this.config.instanceId,
      deviceId: result.deviceId,
      sessionToken: result.sessionToken,
      csrfToken: result.csrfToken,
      sessionExpiresAt: result.sessionExpiresAt,
    }, this.tlsEnabled)
  }

  private async handleLogout(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
    const authorization = this.authorize(request)
    this.requireCsrf(request, authorization)
    this.access.logout(authorization)
    response.setHeader('Set-Cookie', [
      cookie(SESSION_COOKIE, '', { tls: this.tlsEnabled, httpOnly: true, path: '/', maxAgeSeconds: 0 }),
      cookie(CSRF_COOKIE, '', { tls: this.tlsEnabled, httpOnly: false, path: '/', maxAgeSeconds: 0 }),
    ])
    sendJson(response, 200, { loggedOut: true }, this.tlsEnabled)
  }

  private async handleExternalRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const target = parseRequestTarget(request.url)
    const policy = this.requirePolicy()
    const isMutation = request.method !== 'GET' && request.method !== 'HEAD'
    assertExternalTrust(request, policy, isMutation)
    if (target.decodedPathname === LOCAL_ADMIN_PREFIX || target.decodedPathname.startsWith(`${LOCAL_ADMIN_PREFIX}/`)) {
      throw new HttpError(404, 'not_found')
    }
    if (request.method === 'TRACE' || request.method === 'CONNECT') throw new HttpError(405, 'method_not_allowed')

    if (target.search === '' && request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/health`) {
      sendJson(response, 200, { ok: true }, this.tlsEnabled)
      return
    }
    if (target.search === '' && request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/discovery`) {
      sendJson(response, 200, {
        deviceName: discoveryDeviceName(),
        origin: this.address().origin,
        port: this.address().port,
        protocol: DISCOVERY_PROTOCOL,
        instanceId: this.config.instanceId,
      }, this.tlsEnabled)
      return
    }
    if (target.search === '' && request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/ca.cer`) {
      if (this.pairingCaCertificate === undefined) throw new HttpError(404, 'not_found')
      const body = Buffer.from(this.pairingCaCertificate, 'base64')
      setSecurityHeaders(response, this.tlsEnabled)
      response.writeHead(200, {
        'Content-Type': 'application/pkix-cert',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      })
      response.end(body)
      return
    }
    if (target.search === '' && request.method === 'GET'
      && (target.decodedPathname === `${AUTH_PREFIX}/pair` || target.decodedPathname === `${AUTH_PREFIX}/pair.js`)) {
      if (!this.access.pairingStatus().open) throw new HttpError(404, 'not_found')
      setSecurityHeaders(response, this.tlsEnabled)
      const body = target.decodedPathname.endsWith('.js') ? PAIR_SCRIPT : PAIR_PAGE
      response.writeHead(200, {
        'Content-Type': target.decodedPathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      })
      response.end(body)
      return
    }
    if (request.method === 'GET'
      && (target.decodedPathname === `${AUTH_PREFIX}/login` || target.decodedPathname === `${AUTH_PREFIX}/login.js`)) {
      if (target.decodedPathname.endsWith('.js') && target.search !== '') throw new HttpError(400, 'bad_request')
      setSecurityHeaders(response, this.tlsEnabled)
      const body = target.decodedPathname.endsWith('.js') ? LOGIN_SCRIPT : LOGIN_PAGE
      response.writeHead(200, {
        'Content-Type': target.decodedPathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      })
      response.end(body)
      return
    }
    if (target.search === '' && request.method === 'POST' && target.decodedPathname === `${AUTH_PREFIX}/auth/pair`) {
      await this.handlePair(request, response)
      return
    }
    if (target.search === '' && request.method === 'POST' && target.decodedPathname === `${AUTH_PREFIX}/auth/renew`) {
      await this.handleRenew(request, response)
      return
    }
    if (target.search === '' && request.method === 'POST' && target.decodedPathname === `${AUTH_PREFIX}/auth/native-pair`) {
      await this.handleNativePair(request, response)
      return
    }
    if (target.search === '' && request.method === 'POST' && target.decodedPathname === `${AUTH_PREFIX}/auth/native-renew`) {
      await this.handleNativeRenew(request, response)
      return
    }
    if (target.search === '' && request.method === 'POST' && target.decodedPathname === `${AUTH_PREFIX}/auth/logout`) {
      await this.handleLogout(request, response)
      return
    }
    const computerImages = request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/computer-images`
    const computerImage = request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/computer-image`
    const customAsset = request.method === 'GET'
      ? target.decodedPathname === `${AUTH_PREFIX}/custom.css`
        ? {
            file: this.config.customCssFile,
            contentType: 'text/css; charset=utf-8',
            fallback: '/* Add mobile overrides in the DSH home mobile-access/mobile.css file. */\n',
          }
        : target.decodedPathname === `${AUTH_PREFIX}/custom.js`
          ? {
              file: this.config.customScriptFile,
              contentType: 'text/javascript; charset=utf-8',
              fallback: 'window.dshMobile?.register(() => undefined)\n',
            }
          : target.decodedPathname === MOBILE_LAYOUT_PATH
            ? {
                file: this.config.mobileLayoutFile,
                contentType: 'text/javascript; charset=utf-8',
                fallback: undefined,
              }
          : undefined
      : undefined
    if (customAsset === undefined && !computerImages && !computerImage
      && (target.decodedPathname === AUTH_PREFIX || target.decodedPathname.startsWith(`${AUTH_PREFIX}/`))) {
      throw new HttpError(404, 'not_found')
    }

    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
      throw new HttpError(405, 'method_not_allowed')
    }
    if (request.method === 'POST'
      && target.decodedPathname !== '/api'
      && !target.decodedPathname.startsWith('/api/')) {
      throw new HttpError(405, 'method_not_allowed')
    }
    let authorization: SessionAuthorization
    try {
      authorization = this.authorize(request)
    } catch (error) {
      const mapped = mapError(error)
      const acceptsHtml = request.headers.accept?.split(',').some(value => value.trim().split(';', 1)[0] === 'text/html') ?? false
      const topLevel = request.method === 'GET'
        && acceptsHtml
        && (request.headers['sec-fetch-dest'] === undefined || request.headers['sec-fetch-dest'] === 'document')
        && target.decodedPathname !== '/api'
        && !target.decodedPathname.startsWith('/api/')
      if (mapped.status === 401 && topLevel) {
        const returnPath = target.raw.length <= 2048 ? target.raw : '/'
        setSecurityHeaders(response, this.tlsEnabled)
        response.writeHead(302, {
          Location: `${AUTH_PREFIX}/login?return=${encodeURIComponent(returnPath)}`,
          'Content-Length': 0,
        })
        response.end()
        return
      }
      throw error
    }
    if (customAsset !== undefined) {
      let body: Buffer
      try {
        body = await readFile(customAsset.file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (customAsset.fallback === undefined) throw new HttpError(503, 'mobile_frontend_unavailable')
        body = Buffer.from(customAsset.fallback)
      }
      if (body.byteLength > 256 * 1024) throw new HttpError(413, 'payload_too_large')
      setSecurityHeaders(response, this.tlsEnabled)
      response.writeHead(200, {
        'Content-Type': customAsset.contentType,
        'Content-Length': body.byteLength,
        'Cache-Control': 'no-store',
      })
      response.end(body)
      return
    }
    if (computerImages) {
      const query = new URL(target.raw, this.address().origin).searchParams
      sendJson(response, 200, await listComputerImages(query.get('path')), this.tlsEnabled)
      return
    }
    if (computerImage) {
      const query = new URL(target.raw, this.address().origin).searchParams
      const image = await readComputerImage(query.get('path'))
      setSecurityHeaders(response, this.tlsEnabled)
      response.writeHead(200, {
        'Content-Type': image.contentType,
        'Content-Length': image.body.byteLength,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(image.name)}`,
      })
      response.end(image.body)
      return
    }
    const stockFrontend = new URL(target.raw, this.address().origin).searchParams.get('frontend') === 'stock'
    const acceptsHtml = request.headers.accept?.split(',').some(value => value.trim().split(';', 1)[0] === 'text/html') ?? false
    if (request.method === 'GET' && target.decodedPathname === '/' && acceptsHtml && !stockFrontend) {
      await this.proxyMobileIndex(request, response, authorization)
      return
    }
    if (stockFrontend && target.decodedPathname === '/') request.url = '/'
    await this.proxyHttp(request, response, authorization)
  }

  private async proxyMobileIndex(
    request: IncomingMessage,
    response: ServerResponse,
    authorization: SessionAuthorization,
  ): Promise<void> {
    const holder: { request?: ClientRequest } = {}
    const operation = this.allocateRequest(authorization, response, holder)
    try {
      const upstreamHeaders = sanitizeRequestHeaders(request, this.config.upstreamOrigin)
      upstreamHeaders['accept-encoding'] = 'identity'
      const proxied = await new Promise<IncomingMessage>((resolve, reject) => {
        const upstreamRequest = requestHttp({
          protocol: 'http:',
          hostname: stripIpv6Brackets(this.config.upstreamOrigin.hostname),
          port: Number(this.config.upstreamOrigin.port),
          method: 'GET',
          path: '/',
          headers: upstreamHeaders,
          agent: false,
        })
        holder.request = upstreamRequest
        upstreamRequest.setTimeout(this.config.upstreamTimeoutMs, () => {
          upstreamRequest.destroy(new Error('upstream timeout'))
        })
        upstreamRequest.once('response', resolve)
        upstreamRequest.once('error', reject)
        upstreamRequest.end()
      })
      if ((proxied.statusCode ?? 502) !== 200) throw new HttpError(502, 'upstream_unavailable')
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of proxied) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.byteLength
        if (bytes > 4 * 1024 * 1024) throw new HttpError(502, 'upstream_unavailable')
        chunks.push(buffer)
      }
      let body: Buffer
      try {
        body = Buffer.from(rewriteMobileIndex(Buffer.concat(chunks).toString('utf8')))
      } catch {
        throw new HttpError(502, 'upstream_unavailable')
      }
      const headers = sanitizeResponseHeaders(proxied.headers, this.config.upstreamOrigin)
      delete headers['content-length']
      delete headers['content-encoding']
      delete headers.etag
      setSecurityHeaders(response, this.tlsEnabled)
      response.writeHead(200, {
        ...headers,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.byteLength,
      })
      response.end(body)
    } catch (error) {
      holder.request?.destroy()
      if (error instanceof HttpError) throw error
      if (response.headersSent) response.destroy()
      else throw new HttpError(502, 'upstream_unavailable')
    } finally {
      operation.release()
    }
  }

  private allocateRequest(
    authorization: SessionAuthorization,
    response: ServerResponse,
    upstream: { request?: ClientRequest },
  ): { id: number; release: () => void } {
    if (this.activeRequests.size >= this.config.maxActiveRequests) throw new HttpError(429, 'busy')
    const id = this.nextOperationId++
    const abort = (): void => {
      upstream.request?.destroy()
      if (!response.destroyed) response.destroy()
    }
    const timer = setTimeout(abort, Math.max(1, authorization.expiresAt - Date.now()))
    timer.unref()
    this.activeRequests.set(id, Object.freeze({ ...authorization, abort, timer }))
    return {
      id,
      release: () => {
        const entry = this.activeRequests.get(id)
        if (entry !== undefined) clearTimeout(entry.timer)
        this.activeRequests.delete(id)
      },
    }
  }

  private async proxyHttp(
    request: IncomingMessage,
    response: ServerResponse,
    authorization: SessionAuthorization,
  ): Promise<void> {
    const declared = request.headers['content-length']
    if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > this.config.maxBodyBytes)) {
      throw new HttpError(413, 'payload_too_large')
    }
    const holder: { request?: ClientRequest } = {}
    const operation = this.allocateRequest(authorization, response, holder)
    let bodyDone: Promise<void> | undefined
    try {
      const upstreamResponse = new Promise<IncomingMessage>((resolve, reject) => {
        const upstreamRequest = requestHttp({
          protocol: 'http:',
          hostname: stripIpv6Brackets(this.config.upstreamOrigin.hostname),
          port: Number(this.config.upstreamOrigin.port),
          method: request.method,
          path: request.url,
          headers: sanitizeRequestHeaders(request, this.config.upstreamOrigin),
          agent: false,
        })
        holder.request = upstreamRequest
        upstreamRequest.setTimeout(this.config.upstreamTimeoutMs, () => {
          upstreamRequest.destroy(new Error('upstream timeout'))
        })
        upstreamRequest.once('response', resolve)
        upstreamRequest.once('error', reject)
        bodyDone = pipeline(request, new ByteLimitTransform(this.config.maxBodyBytes), upstreamRequest)
        void bodyDone.catch(reject)
      })
      const proxied = await upstreamResponse
      setSecurityHeaders(response, this.tlsEnabled)
      response.writeHead(proxied.statusCode ?? 502, sanitizeResponseHeaders(proxied.headers, this.config.upstreamOrigin))
      await Promise.all([bodyDone, pipeline(proxied, response)])
    } catch (error) {
      holder.request?.destroy()
      await bodyDone?.catch(() => undefined)
      if (error instanceof HttpError) throw error
      if (response.headersSent) response.destroy()
      else throw new HttpError(502, 'upstream_unavailable')
    } finally {
      operation.release()
    }
  }

  private abortSessionResources(sessionKey: string): void {
    for (const request of this.activeRequests.values()) {
      if (request.sessionKey === sessionKey) request.abort()
    }
    for (const socket of this.activeWebSockets.values()) {
      if (socket.sessionKey === sessionKey) {
        socket.client.destroy()
        socket.upstream.destroy()
      }
    }
  }

  private async readUpgradeResponse(upstream: Socket, expectedAccept: string): Promise<{ header: string; remainder: Buffer }> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0)
      const failed = (error: Error): void => { cleanup(); reject(error) }
      const closed = (): void => { cleanup(); reject(new Error('upstream closed during WebSocket handshake')) }
      const data = (chunk: Buffer): void => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length > MAX_HEADER_BYTES) {
          failed(new Error('upstream WebSocket headers are too large'))
          return
        }
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        cleanup()
        const lines = buffer.subarray(0, end).toString('latin1').split('\r\n')
        if (lines.shift() !== 'HTTP/1.1 101 Switching Protocols') {
          reject(new Error('upstream refused WebSocket upgrade'))
          return
        }
        const selected = new Map<string, string>()
        for (const line of lines) {
          const colon = line.indexOf(':')
          if (colon <= 0) {
            reject(new Error('upstream returned malformed WebSocket headers'))
            return
          }
          const name = line.slice(0, colon).trim().toLowerCase()
          const value = line.slice(colon + 1).trim()
          if (selected.has(name)) {
            reject(new Error('upstream returned duplicate WebSocket headers'))
            return
          }
          selected.set(name, value)
        }
        if (selected.get('upgrade')?.toLowerCase() !== 'websocket'
          || !hasToken(selected.get('connection'), 'upgrade')
          || selected.get('sec-websocket-accept') !== expectedAccept) {
          reject(new Error('upstream returned an invalid WebSocket handshake'))
          return
        }
        const output = [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${expectedAccept}`,
        ]
        const protocol = selected.get('sec-websocket-protocol')
        const extensions = selected.get('sec-websocket-extensions')
        if (protocol !== undefined) output.push(`Sec-WebSocket-Protocol: ${protocol}`)
        if (extensions !== undefined) output.push(`Sec-WebSocket-Extensions: ${extensions}`)
        output.push('Referrer-Policy: no-referrer', 'X-Content-Type-Options: nosniff', '', '')
        resolve({ header: output.join('\r\n'), remainder: buffer.subarray(end + 4) })
      }
      const cleanup = (): void => {
        upstream.off('data', data)
        upstream.off('error', failed)
        upstream.off('close', closed)
      }
      upstream.on('data', data)
      upstream.once('error', failed)
      upstream.once('close', closed)
    })
  }

  private async handleUpgrade(request: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    const target = parseRequestTarget(request.url)
    const policy = this.requirePolicy()
    // Android WebView WebSockets do not consistently carry Fetch Metadata.
    // Exact Origin, direct CIDR, exact Host, and the short Session Cookie
    // remain mandatory; when Sec-Fetch-Site is present, assertExternalTrust
    // still requires it to be same-origin.
    assertExternalTrust(request, policy, false)
    if (!policy.acceptsOrigin(request.headers.origin)) throw new HttpError(403, 'forbidden')
    if (target.search !== '' || !WS_PATHS.has(target.decodedPathname)) throw new HttpError(404, 'not_found')
    if (request.method !== 'GET' || headerValue(request.headers, 'upgrade')?.toLowerCase() !== 'websocket'
      || !hasToken(headerValue(request.headers, 'connection'), 'upgrade')) {
      throw new HttpError(400, 'bad_request')
    }
    const key = headerValue(request.headers, 'sec-websocket-key')
    if (key === undefined || headerValue(request.headers, 'sec-websocket-version') !== '13') {
      throw new HttpError(400, 'bad_request')
    }
    let decodedKey: Buffer
    try {
      decodedKey = Buffer.from(key, 'base64')
    } catch {
      throw new HttpError(400, 'bad_request')
    }
    if (decodedKey.length !== 16 || decodedKey.toString('base64') !== key) throw new HttpError(400, 'bad_request')
    const authorization = this.authorize(request)
    if (this.activeWebSockets.size >= this.config.maxWebSockets) throw new HttpError(429, 'busy')

    const upstream = connect({
      host: stripIpv6Brackets(this.config.upstreamOrigin.hostname),
      port: Number(this.config.upstreamOrigin.port),
    })
    client.pause()
    const id = this.nextOperationId++
    const closeBoth = (): void => {
      client.destroy()
      upstream.destroy()
    }
    const timer = setTimeout(closeBoth, Math.max(1, authorization.expiresAt - Date.now()))
    timer.unref()
    const record: ActiveWebSocket = Object.freeze({ ...authorization, client, upstream, timer })
    this.activeWebSockets.set(id, record)
    const cleanup = (): void => {
      const active = this.activeWebSockets.get(id)
      if (active !== undefined) clearTimeout(active.timer)
      this.activeWebSockets.delete(id)
    }
    client.once('close', () => { upstream.destroy(); cleanup() })
    upstream.once('close', () => { client.destroy(); cleanup() })
    upstream.setTimeout(this.config.upstreamTimeoutMs, closeBoth)
    try {
      await new Promise<void>((resolve, reject) => {
        upstream.once('connect', resolve)
        upstream.once('error', reject)
      })
      const requestLines = [
        `GET ${target.raw} HTTP/1.1`,
        `Host: ${this.config.upstreamOrigin.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Origin: ${this.config.upstreamOrigin.origin}`,
        'Sec-Fetch-Site: same-origin',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ]
      const protocol = headerValue(request.headers, 'sec-websocket-protocol')
      const extensions = headerValue(request.headers, 'sec-websocket-extensions')
      if (protocol !== undefined) requestLines.push(`Sec-WebSocket-Protocol: ${protocol}`)
      if (extensions !== undefined) requestLines.push(`Sec-WebSocket-Extensions: ${extensions}`)
      requestLines.push('', '')
      upstream.write(requestLines.join('\r\n'))
      if (head.length > 0) upstream.write(head)
      const handshake = await this.readUpgradeResponse(upstream, websocketAccept(key))
      upstream.setTimeout(0)
      client.write(handshake.header)
      if (handshake.remainder.length > 0) client.write(handshake.remainder)
      upstream.pipe(client)
      client.pipe(upstream)
      client.resume()
    } catch (error) {
      closeBoth()
      if (error instanceof HttpError) throw error
      throw new HttpError(502, 'upstream_unavailable')
    }
  }

  /** Loopback-only DSH WebServer route for opening pairing and managing devices. */
  localAdminRoute(): WebRoute {
    return {
      kind: 'prefix',
      path: LOCAL_ADMIN_PREFIX,
      handler: async (request, response) => {
        try {
          const target = parseRequestTarget(request.url)
          const mutation = request.method === 'POST'
          assertLocalAdminTrust(request, mutation)
          if (target.search !== '') throw new HttpError(400, 'bad_request')
          if (request.method === 'GET' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/status`) {
            sendJson(response, 200, {
              gateway: this.address(),
              pairing: this.access.pairingStatus(),
              deviceCount: this.access.listDevices().length,
              resources: {
                connections: this.connectedSockets.size,
                activeRequests: this.activeRequests.size,
                webSockets: this.activeWebSockets.size,
              },
            }, false)
            return
          }
          if (request.method === 'GET' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/devices`) {
            sendJson(response, 200, { devices: this.access.listDevices() }, false)
            return
          }
          if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/pairing/open`) {
            const body = await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
            if (body.ttlMs !== undefined && typeof body.ttlMs !== 'number') throw new HttpError(400, 'bad_request')
            const opened = await this.access.openPairing(body.ttlMs as number | undefined)
            sendJson(response, 201, {
              ...opened,
              appKey: `dsh1.${this.config.instanceId}.${opened.token}`,
              pairUrl: `${this.address().origin}/mobile-access/pair#token=${opened.token}`,
            }, false)
            return
          }
          if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/devices/revoke`) {
            const body = await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
            if (typeof body.deviceId !== 'string' || !/^[a-f\d]{32}$/u.test(body.deviceId)) {
              throw new HttpError(400, 'bad_request')
            }
            const revoked = await this.access.revokeDevice(body.deviceId)
            if (!revoked) throw new HttpError(404, 'not_found')
            sendJson(response, 200, { revoked: true }, false)
            return
          }
          if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/devices/reset`) {
            const body = await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
            if (body.confirm !== true) throw new HttpError(400, 'bad_request')
            await this.access.resetDevices()
            sendJson(response, 200, { reset: true }, false)
            return
          }
          throw new HttpError(404, 'not_found')
        } catch (error) {
          const mapped = mapError(error)
          if (response.headersSent) response.destroy()
          else sendFailure(response, mapped.status, mapped.code, false)
        }
      },
    }
  }

  /** Close listeners and abort all accepted work before resolving teardown. */
  async close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask
    this.closeTask = this.performClose()
    return this.closeTask
  }

  private async performClose(): Promise<void> {
    this.closing = true
    this.removeSessionListener()
    const accessClose = this.access.close()
    for (const request of this.activeRequests.values()) request.abort()
    for (const websocket of this.activeWebSockets.values()) {
      websocket.client.destroy()
      websocket.upstream.destroy()
    }
    for (const socket of this.connectedSockets) socket.destroy()
    if (this.discoveryTimer !== undefined) clearInterval(this.discoveryTimer)
    this.discoveryTimer = undefined
    await this.closeBonjour()
    const discoverySocket = this.discoverySocket
    this.discoverySocket = undefined
    if (discoverySocket !== undefined) {
      await new Promise<void>(resolve => { discoverySocket.close(() => resolve()) })
    }
    const server = this.server
    this.server = undefined
    if (server !== undefined && server.listening) {
      server.closeAllConnections()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
    await accessClose
    this.activeRequests.clear()
    this.activeWebSockets.clear()
    this.connectedSockets.clear()
    this.policy = undefined
    this.listenerPort = undefined
  }

  /** Safe metadata helper for direct loopback integrations. */
  devices(): readonly DeviceSummary[] {
    return this.access.listDevices()
  }
}
