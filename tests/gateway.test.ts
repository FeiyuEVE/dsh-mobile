import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as requestHttp, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http'
import { request as requestHttps } from 'node:https'
import { dirname, join } from 'node:path'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { MobileAccessGateway, LOG_QUERY_HEADER, LOG_QUERY_KEY } from '../src/gateway.js'
import { CSRF_HEADER, DEVICE_COOKIE, SESSION_COOKIE } from '../src/http-security.js'
import { APP_ASSETS_PREFIX, CODE_PUSH_PREFIX } from '../src/hot-update.js'
import {
  AccountController,
  DEFAULT_TOKEN_TTL_MS,
  MemoryAccountStore,
  MemoryTokenStore,
  type AccountControllerOptions,
} from '../src/account.js'
import { DSH_MOBILE_VERSION, MINIMUM_ANDROID_APP_VERSION } from '../src/version.js'
import { createTestTlsChain } from './tls-fixtures.js'
import { TMP_ROOT, createTempDirectory } from './tmp-root.js'

interface HttpResult {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
  readonly rawBody: Buffer
}

interface UpstreamObservation {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

const cleanups: Array<() => Promise<void>> = []
// Above `net.ipv4.ip_local_port_range` (32768-60999) on purpose: the host runs long-lived tunnels
// (`dsh-v6-front` forks a socat per connection), and any such connection parked on one of these
// ports would make every bind in this file fail with EADDRINUSE.
const TEST_GATEWAY_PORT = 61980
const TEST_FAILED_START_PORT = 61981
const SESSION_HISTORY_PATH = '/api/session.history'
const COMPRESSIBLE_SCRIPT = 'globalThis.__compressionProbe = true;\n'.repeat(256)
const UPSTREAM_LAUNCH_TOKEN = 'test-launch-token'
const UPSTREAM_BROWSER_COOKIE = 'dsh-auth-test=v1.signed-cookie'
const HISTORY_RESPONSE = JSON.stringify({
  type: 'client-response',
  result: { ok: true, value: { events: [{ event: { type: 'assistant/chunk', content: 'history '.repeat(2_048) } }] } },
})

// 项目产物不落 /tmp：测试工作目录一律放仓库根 `.tmp/`（已在 .gitignore），
// 每个用例结束时由 cleanups 清理自己建的那份。
const [TEST_USERNAME, TEST_PASSWORD] = ['feiyueve', 'hmw-correct-horse-battery'] as const

/** 记录 helper 为每个网关实例建的 AccountController（构造函数把它设为私有）。 */
const gatewayAccounts = new WeakMap<MobileAccessGateway, AccountController>()

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await createTempDirectory(prefix)
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return (server.address() as AddressInfo).port
}

async function closeServer(server: Server, sockets: Set<Socket> = new Set()): Promise<void> {
  for (const socket of sockets) socket.destroy()
  if (!server.listening) return
  server.closeAllConnections()
  await new Promise<void>(resolve => { server.close(() => resolve()) })
}

async function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const body = options.body
    const headers = { ...options.headers }
    if (body !== undefined && headers['content-length'] === undefined) headers['content-length'] = String(Buffer.byteLength(body))
    const outgoing = requestHttp({
      host: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers,
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      response.once('end', () => {
        const rawBody = Buffer.concat(chunks)
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: rawBody.toString('utf8'), rawBody })
      })
    })
    outgoing.once('error', reject)
    outgoing.end(body)
  })
}

async function udpDiscovery(port: number): Promise<Record<string, unknown>> {
  const client = createSocket('udp4')
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.close(); reject(new Error('UDP discovery timed out')) }, 2_000)
    client.once('error', (error) => { clearTimeout(timer); client.close(); reject(error) })
    client.once('message', (message) => {
      clearTimeout(timer)
      client.close()
      resolve(JSON.parse(message.toString('utf8')) as Record<string, unknown>)
    })
    client.send(Buffer.from('DSH_MOBILE_DISCOVER_V1', 'ascii'), port, '127.0.0.1')
  })
}

async function trustedHttpsRequest(port: number, path: string, rootCert: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const outgoing = requestHttps({
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      ca: rootCert,
      rejectUnauthorized: true,
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      response.once('end', () => {
        const rawBody = Buffer.concat(chunks)
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: rawBody.toString('utf8'), rawBody })
      })
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

async function tlsFixtureFiles(): Promise<{
  readonly leaf: string
  readonly fullchain: string
  readonly intermediate: string
  readonly root: string
  readonly rootCert: string
  readonly key: string
}> {
  const directory = await tempDirectory('dsh-mobile-access-tls-')
  const chain = createTestTlsChain()
  const files = {
    leaf: join(directory, 'leaf.pem'),
    fullchain: join(directory, 'fullchain.pem'),
    intermediate: join(directory, 'intermediate.pem'),
    root: join(directory, 'root.pem'),
    key: join(directory, 'leaf-key.pem'),
  }
  await Promise.all([
    writeFile(files.leaf, chain.leafCert, 'utf8'),
    writeFile(files.fullchain, `${chain.leafCert}${chain.intermediateCert}`, 'utf8'),
    writeFile(files.intermediate, chain.intermediateCert, 'utf8'),
    writeFile(files.root, chain.rootCert, 'utf8'),
    writeFile(files.key, chain.leafKey, { encoding: 'utf8', mode: 0o600 }),
  ])
  return { ...files, rootCert: chain.rootCert }
}

function cookiesByName(headers: IncomingHttpHeaders): Map<string, string> {
  const result = new Map<string, string>()
  for (const line of headers['set-cookie'] ?? []) {
    const pair = line.split(';', 1)[0]
    if (pair === undefined) continue
    const equals = pair.indexOf('=')
    if (equals > 0) result.set(pair.slice(0, equals), pair.slice(equals + 1))
  }
  return result
}

function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'ascii').digest('base64')
}

async function upstream(boot: 'legacy' | 'batched' | 'relative' = 'legacy', requireAuthentication = false): Promise<{
  port: number
  observations: UpstreamObservation[]
  upgradeObservations: IncomingHttpHeaders[]
  releaseHold: () => void
}> {
  const observations: UpstreamObservation[] = []
  const upgradeObservations: IncomingHttpHeaders[] = []
  const held: Array<() => void> = []
  const upgraded = new Set<Socket>()
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    observations.push({
      method: incoming.method ?? '',
      url: incoming.url ?? '',
      headers: incoming.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    })
    if (requireAuthentication && incoming.url === `/?token=${UPSTREAM_LAUNCH_TOKEN}`) {
      response.writeHead(303, {
        location: '/',
        'set-cookie': `${UPSTREAM_BROWSER_COOKIE}; Max-Age=1800; Path=/; HttpOnly; SameSite=Strict`,
      })
      response.end()
      return
    }
    if (requireAuthentication && incoming.headers.cookie !== UPSTREAM_BROWSER_COOKIE) {
      response.writeHead(401, { 'content-type': 'text/plain' })
      response.end('authentication required')
      return
    }
    if (incoming.url === '/hold') {
      held.push(() => { response.writeHead(200); response.end('released') })
      return
    }
    if (incoming.url === '/' && incoming.headers.accept?.includes('text/html')) {
      // 'relative' 复刻 dsh 0.1.7 的 boot manifest：条目 URL 没有前导斜杠
      // （上游 `packages/client/modules/src/index.ts:472` 的 `artifact.url.slice(1)`）。
      // 'batched' 是 0.1.2..0.1.6 的绝对形态。preload 两种形态各自对应。
      const entries = boot === 'legacy'
        ? [
            { id: '@deepseek-ai/dsh-client-ui-layout', url: '/plugins/layout.js', rev: 'stock-layout', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'] },
            { id: 'feature', url: '/plugins/feature.js', rev: 'feature' },
          ]
        : [
            { id: '@deepseek-ai/dsh-client-ui-renderer', url: `${boot === 'relative' ? '' : '/'}plugins/renderer.js?rev=renderer`, rev: 'renderer' },
            {
              id: '@deepseek-ai/dsh-client-ui-layout',
              url: `${boot === 'relative' ? '' : '/'}plugins/layout.js?rev=layout`,
              rev: 'layout',
              inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-theme'],
            },
            { id: 'feature', url: `${boot === 'relative' ? '' : '/'}plugins/feature.js?rev=feature`, rev: 'feature' },
          ]
      const graph = boot === 'legacy'
        ? { rev: 'stock', entries }
        : { rev: 'stock', entries, batches: [{ phase: 'application', url: `${boot === 'relative' ? '' : '/'}plugins/application.js?rev=stock`, rev: 'stock-batch', entries: entries.map(entry => entry.id) }] }
      const preload = boot === 'relative'
        ? '<link rel="preload" as="script" href="plugins/??feature.js&rev=feature">'
        : '<link rel="preload" as="script" href="/plugins/??feature.js&rev=feature">'
      const body = `<!doctype html><html><head>${preload}<script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(graph)};</script></head><body></body></html>`
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }
    if (incoming.url === '/plugins/events') {
      // SSE 长连接：只发握手帧，之后长期无数据（与线上 /plugins/events 行为一致）
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      response.write(': connected\n\n')
      // 线上上游一连上就推一帧 stock graph，随后按需推单模块 rebuilt 帧。
      response.write(`data: ${JSON.stringify({ type: 'graph', graph: { rev: 'stock', entries: [], batches: [] } })}\n\n`)
      response.write(`data: ${JSON.stringify({ type: 'rebuilt', id: 'feature', rev: 'feature-2' })}\n\n`)
      return
    }
    if ((boot === 'batched' || boot === 'relative') && incoming.url?.startsWith('/plugins/') === true) {
      const body = `globalThis.__loadedMobileFixture ??= []; globalThis.__loadedMobileFixture.push(${JSON.stringify(incoming.url)});\n`
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }
    if (incoming.url?.startsWith('/plugins/compressible.js') === true) {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': Buffer.byteLength(COMPRESSIBLE_SCRIPT),
        'cache-control': 'no-store',
        etag: '"compressible-script"',
      })
      response.end(COMPRESSIBLE_SCRIPT)
      return
    }
    if (incoming.url === '/api/session.history') {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(HISTORY_RESPONSE),
      })
      response.end(HISTORY_RESPONSE)
      return
    }
    const body = `${JSON.stringify({ ok: true, method: incoming.method, url: incoming.url })}\n`
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'public, max-age=3600',
      'expires': 'Wed, 21 Oct 2099 07:28:00 GMT',
      'pragma': 'cache',
      'set-cookie': 'upstream-secret=must-not-pass',
      'x-powered-by': 'hidden',
    })
    response.end(body)
  })
  server.on('upgrade', (incoming, socket) => {
    const networkSocket = socket as Socket
    upgraded.add(networkSocket)
    networkSocket.on('error', () => { networkSocket.destroy() })
    networkSocket.once('close', () => { upgraded.delete(networkSocket) })
    upgradeObservations.push(incoming.headers)
    if (requireAuthentication && incoming.headers.cookie !== UPSTREAM_BROWSER_COOKIE) {
      networkSocket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    const key = incoming.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      networkSocket.destroy()
      return
    }
    networkSocket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      'Set-Cookie: upstream-secret=must-not-pass',
      '',
      '',
    ].join('\r\n'))
    networkSocket.pipe(networkSocket)
  })
  const port = await listen(server)
  cleanups.push(() => closeServer(server, upgraded))
  return {
    port,
    observations,
    upgradeObservations,
    releaseHold: () => { for (const release of held.splice(0)) release() },
  }
}

async function gateway(
  upstreamPort: number,
  overrides: Record<string, unknown> = {},
  testSessionTtlMs?: number,
  upstreamAuthenticatedUrl?: string,
  accountOverrides: Partial<AccountControllerOptions> = {},
): Promise<MobileAccessGateway> {
  await mkdir(TMP_ROOT, { recursive: true })
  const resolved = parseGatewayConfig({
    listenHost: '127.0.0.1',
    listenPort: TEST_GATEWAY_PORT,
    upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`,
    publicAuthorities: ['127.0.0.1'],
    allowedCidrs: ['127.0.0.0/8'],
    stateFile: join(TMP_ROOT, `dsh-mobile-access-${randomUUID()}.json`),
    tls: { mode: 'disabled' },
    ...overrides,
  })
  const effective = testSessionTtlMs === undefined ? resolved : Object.freeze({ ...resolved, sessionTtlMs: testSessionTtlMs })
  const account = new AccountController(new MemoryAccountStore(), new MemoryTokenStore(), {
    tokenTtlMs: DEFAULT_TOKEN_TTL_MS,
    maxTokens: 8,
    rateLimitWindowMs: 60_000,
    maxLoginAttempts: 5,
    maxRateLimitKeys: 64,
    ...accountOverrides,
  })
  // 第二参现在是必填的 AccountController；extensions 省略，第四参是上游认证 URL。
  const instance = new MobileAccessGateway(effective, account, undefined, upstreamAuthenticatedUrl)
  await instance.start()
  gatewayAccounts.set(instance, account)
  cleanups.push(() => instance.close())
  return instance
}

function browserHeaders(instance: MobileAccessGateway): Record<string, string> {
  const origin = instance.address().origin
  return {
    host: new URL(origin).host,
    origin,
    'sec-fetch-site': 'same-origin',
  }
}

function accountOf(instance: MobileAccessGateway): AccountController {
  const account = gatewayAccounts.get(instance)
  if (account === undefined) throw new Error('gateway was not created by the test helper')
  return account
}

/** 幂等地配置单账号（旧 `openPairing()` 的替代：凭据只有一个来源）。 */
async function configureAccount(instance: MobileAccessGateway): Promise<AccountController> {
  const account = accountOf(instance)
  if (!account.hasAccount()) await account.setAccount(TEST_USERNAME, TEST_PASSWORD)
  return account
}

/**
 * 账号登录 helper：替掉旧的 `pair()`（`openPairing()` + `POST /auth/pair`）。
 * 返回的 `session` 就是 `SESSION_COOKIE` 里的那枚 token（同一枚凭据的两种形态）。
 */
async function signIn(instance: MobileAccessGateway, label = 'Test phone'): Promise<{
  token: string
  tokenId: string
  session: string
  csrf: string
}> {
  await configureAccount(instance)
  const result = await request(instance.address().port, '/mobile-access/auth/login', {
    method: 'POST',
    headers: { ...browserHeaders(instance), 'content-type': 'application/json' },
    body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD, label }),
  })
  expect(result.status).toBe(200)
  const body = JSON.parse(result.body) as { token: string; tokenId: string; csrfToken: string }
  const cookies = cookiesByName(result.headers)
  return {
    token: body.token,
    tokenId: body.tokenId,
    session: cookies.get(SESSION_COOKIE) ?? body.token,
    csrf: body.csrfToken,
  }
}

async function openWebSocket(
  instance: MobileAccessGateway,
  path: string,
  session: string,
  origin?: string,
  fetchSite: string | undefined = 'same-origin',
): Promise<{
  socket: Socket
  response: string
}> {
  const address = instance.address()
  const key = Buffer.from('0123456789abcdef').toString('base64')
  return new Promise((resolve, reject) => {
    const socket = connect(address.port, '127.0.0.1')
    let buffer = Buffer.alloc(0)
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('WebSocket handshake timed out')) }, 3_000)
    socket.once('error', reject)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      clearTimeout(timeout)
      resolve({ socket, response: buffer.subarray(0, end).toString('latin1') })
    })
    socket.once('connect', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: ${new URL(address.origin).host}`,
        `Origin: ${origin ?? address.origin}`,
        ...(fetchSite === undefined ? [] : [`Sec-Fetch-Site: ${fetchSite}`]),
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        `Cookie: ${SESSION_COOKIE}=${session}; attacker=outside`,
        '',
        '',
      ].join('\r\n'))
    })
  })
}

describe('HTTP gateway', () => {
  it('drops the upstream stock graph frame from the mobile /plugins/events stream', async () => {
    // 回归（2026-09-23，dsh 0.1.7 手机白屏）：上游推的 stock graph 一旦到达页面，
    // `entries.sync(graph)` 会把网关改写过的 boot graph（专属移动布局 + mobile-boot
    // 批次）整体覆盖回 stock，布局模块被重新拉取、root 注册被冲掉 →
    // `renderSlot('root') before any 'root' registration (boot order)` → React 树崩、白屏。
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await signIn(instance)
    const body = await new Promise<string>((resolve, reject) => {
      const outgoing = requestHttp({
        host: '127.0.0.1',
        port: instance.address().port,
        path: '/plugins/events',
        method: 'GET',
        headers: {
          ...browserHeaders(instance),
          cookie: `${SESSION_COOKIE}=${paired.session}`,
          accept: 'text/event-stream',
        },
        agent: false,
      }, (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += String(chunk)
          // 三帧都到齐（graph 被丢、rebuilt 与注释透传）即可收工。
          if (text.includes('rebuilt') && text.includes(': connected')) { response.destroy(); resolve(text) }
        })
        response.once('error', (error) => reject(error))
      })
      outgoing.once('error', reject)
      outgoing.end()
      setTimeout(() => { outgoing.destroy(); resolve('') }, 5_000).unref()
    })
    expect(body).toContain(': connected')
    expect(body).toContain('"type":"rebuilt"')
    expect(body).not.toContain('"type":"graph"')
    expect(body).not.toContain('"graph"')
  })

  it('keeps the /plugins/events SSE uncompressed and alive past the upstream idle timeout', async () => {
    const inner = await upstream()
    // 上游空闲超时压到 1s：修复前本用例会在 1s 后断流（线上 upstreamTimeoutMs=300s，
    // 表现为移动端每 5 分钟一次 ERR_INCOMPLETE_CHUNKED_ENCODING → 整页重连）。
    const instance = await gateway(inner.port, { upstreamTimeoutMs: 1_000 })
    const paired = await signIn(instance)
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = requestHttp({
        host: '127.0.0.1',
        port: instance.address().port,
        path: '/plugins/events',
        method: 'GET',
        headers: {
          ...browserHeaders(instance),
          cookie: `${SESSION_COOKIE}=${paired.session}`,
          accept: 'text/event-stream',
          'accept-encoding': 'gzip',
        },
        agent: false,
      }, resolve)
      outgoing.once('error', reject)
      outgoing.end()
    })
    cleanups.push(async () => { response.destroy() })
    expect(response.statusCode).toBe(200)
    let body = ''
    let settled = false
    response.setEncoding('utf8')
    response.on('data', (chunk) => { body += String(chunk) })
    response.once('end', () => { settled = true })
    response.once('aborted', () => { settled = true })
    response.once('error', () => { settled = true })
    // 握手帧必须立刻到达：gzip 会把这类小帧缓冲住，客户端长时间收不到任何字节。
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SSE handshake frame never arrived: ${JSON.stringify(body)}`)), 2_000)
      response.on('data', () => {
        if (body.includes(': connected')) { clearTimeout(timer); resolve() }
      })
    })
    // SSE 不能被 gzip 包裹（Content-Encoding 一旦出现即说明压缩路径吞帧）。
    expect(response.headers['content-encoding']).toBeUndefined()
    // 静默 1.5s（> upstreamTimeoutMs）后连接必须仍然活着。
    await new Promise(resolve => setTimeout(resolve, 1_500))
    expect(settled).toBe(false)
    expect(body).toContain(': connected')
    expect(inner.observations.some(observation => observation.url === '/plugins/events')).toBe(true)
  })

  it('serves authenticated computer image browsing without proxying filesystem paths', async () => {
    const inner = await upstream()
    const directory = await tempDirectory('dsh-mobile-computer-files-')
    await mkdir(join(directory, 'album'))
    await writeFile(join(directory, 'photo.png'), 'mobile-image')
    const instance = await gateway(inner.port)
    const paired = await signIn(instance)
    const headers = {
      ...browserHeaders(instance),
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }
    const listing = await request(instance.address().port, `/mobile-access/computer-images?path=${encodeURIComponent(directory)}`, { headers })
    expect(listing.status).toBe(200)
    expect(JSON.parse(listing.body)).toMatchObject({ entries: [
      { kind: 'directory', name: 'album' },
      { kind: 'image', name: 'photo.png' },
    ] })
    const image = await request(instance.address().port, `/mobile-access/computer-image?path=${encodeURIComponent(join(directory, 'photo.png'))}`, { headers })
    expect(image.status).toBe(200)
    expect(image.headers['content-type']).toBe('image/png')
    expect(image.rawBody.toString()).toBe('mobile-image')
    expect(inner.observations).toHaveLength(0)
    const unauthenticated = await request(instance.address().port, `/mobile-access/computer-images?path=${encodeURIComponent(directory)}`, {
      headers: browserHeaders(instance),
    })
    expect(unauthenticated.status).toBe(401)
  })

  it('serves the latest authenticated mobile Web assets without caching them', async () => {
    const inner = await upstream()
    const directory = await tempDirectory('dsh-mobile-css-')
    const customCssFile = join(directory, 'mobile.css')
    const customScriptFile = join(directory, 'mobile.js')
    const mobileLayoutFile = join(directory, 'mobile-layout.js')
    await writeFile(customCssFile, ':root { --preview: first; }\n', 'utf8')
    await writeFile(customScriptFile, 'window.dshMobile.register(() => undefined)\n', 'utf8')
    await writeFile(mobileLayoutFile, 'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-ui-layout" })\n', 'utf8')
    const instance = await gateway(inner.port, { customCssFile, customScriptFile, mobileLayoutFile })
    const paired = await signIn(instance)
    const headers = {
      ...browserHeaders(instance),
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    const first = await request(instance.address().port, '/mobile-access/custom.css', { headers })
    expect(first.status).toBe(200)
    expect(first.headers['cache-control']).toBe('no-store')
    expect(first.headers.etag).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.headers['last-modified']).toBeDefined()
    expect(first.body).toContain('--preview: first')

    const cached = await request(instance.address().port, '/mobile-access/custom.css', {
      headers: { ...headers, 'if-none-match': String(first.headers.etag) },
    })
    expect(cached.status).toBe(304)
    expect(cached.body).toBe('')

    const script = await request(instance.address().port, '/mobile-access/custom.js', { headers })
    expect(script.status).toBe(200)
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(script.headers['cache-control']).toBe('no-store')
    expect(script.body).toContain('dshMobile.register')

    const layout = await request(instance.address().port, '/mobile-access/mobile-layout.js', { headers })
    expect(layout.status).toBe(200)
    expect(layout.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(layout.body).toContain('@deepseek-ai/dsh-client-ui-layout')

    await writeFile(customCssFile, ':root { --preview: second; }\n', 'utf8')
    const second = await request(instance.address().port, '/mobile-access/custom.css', { headers })
    expect(second.status).toBe(200)
    expect(second.body).toContain('--preview: second')
    expect(inner.observations).toHaveLength(0)
  })

  it('serves the dedicated layout at the authenticated root while retaining a stock escape hatch', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await signIn(instance)
    const headers = {
      ...browserHeaders(instance),
      accept: 'text/html,application/xhtml+xml',
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    const mobile = await request(instance.address().port, '/', { headers })
    expect(mobile.status).toBe(200)
    expect(mobile.body).toContain('window.__DSH_MOBILE_FRONTEND__="dedicated"')
    expect(mobile.body).toContain('/mobile-access/mobile-layout.js')
    expect(mobile.body).toContain('/plugins/feature.js')

    const deepLink = await request(instance.address().port, '/sessions/example', { headers })
    expect(deepLink.status).toBe(200)
    expect(deepLink.body).toContain('window.__DSH_MOBILE_FRONTEND__="dedicated"')

    const stock = await request(instance.address().port, '/?frontend=stock', { headers })
    expect(stock.status).toBe(200)
    expect(stock.body).not.toContain('__DSH_MOBILE_FRONTEND__')
    expect(stock.body).toContain('/plugins/layout.js')
  })

  it('assembles the mobile boot batch when the boot manifest uses 0.1.7 relative plugin URLs', async () => {
    // 回归（2026-09-23，dsh 0.1.7 升级时线上手机白屏抓到）：0.1.7 的 boot manifest 条目
    // URL 去掉了前导斜杠，`readUpstreamClientBundle` 只认 `/plugins/` 会让整份批次 502
    // （`upstream_unavailable`），专用移动前端因此起不来。
    const inner = await upstream('relative')
    const directory = await tempDirectory('dsh-mobile-relative-layout-')
    const mobileLayoutFile = join(directory, 'mobile-layout.js')
    await writeFile(mobileLayoutFile, 'globalThis.__dedicatedMobileLayout = true;\n', 'utf8')
    const instance = await gateway(inner.port, { mobileLayoutFile })
    const paired = await signIn(instance)
    const headers = {
      ...browserHeaders(instance),
      accept: 'text/html,application/xhtml+xml',
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    const mobile = await request(instance.address().port, '/', { headers })
    expect(mobile.status).toBe(200)
    // 相对形态的 preload 也必须被剥掉（否则手机上整包下载两次）
    expect(mobile.body).not.toContain('rel="preload" as="script" href="plugins/??')
    const match = /"url":"(\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js)"/u.exec(mobile.body)
    expect(match?.[1]).toBeDefined()
    const batch = await request(instance.address().port, match![1]!, { headers })
    expect(batch.status).toBe(200)
    expect(batch.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(batch.body).toContain('renderer.js?rev=renderer')
    expect(batch.body).toContain('__dedicatedMobileLayout = true')
    expect(batch.body).toContain('feature.js?rev=feature')
    expect(batch.body).not.toContain('layout.js?rev=layout')
  })

  it('serves a DSH 0.1.2 mobile application batch without the stock layout factory', async () => {
    const inner = await upstream('batched')
    const directory = await tempDirectory('dsh-mobile-batched-layout-')
    const mobileLayoutFile = join(directory, 'mobile-layout.js')
    await writeFile(mobileLayoutFile, 'globalThis.__dedicatedMobileLayout = true;\n', 'utf8')
    const instance = await gateway(inner.port, { mobileLayoutFile })
    const paired = await signIn(instance)
    const headers = {
      ...browserHeaders(instance),
      accept: 'text/html,application/xhtml+xml',
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    const mobile = await request(instance.address().port, '/', { headers })
    expect(mobile.status).toBe(200)
    const match = /"url":"(\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js)"/u.exec(mobile.body)
    expect(match?.[1]).toBeDefined()
    const path = match![1]!
    const batch = await request(instance.address().port, path, { headers })
    expect(batch.status).toBe(200)
    expect(batch.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(batch.headers.etag).toMatch(/^[a-f\d]{64}$/u)
    expect(batch.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect(batch.body).toContain('/plugins/renderer.js?rev=renderer')
    expect(batch.body).toContain('__dedicatedMobileLayout = true')
    expect(batch.body).toContain('/plugins/feature.js?rev=feature')
    expect(batch.body).not.toContain('/plugins/layout.js?rev=layout')
    expect(batch.body.indexOf('renderer.js')).toBeLessThan(batch.body.indexOf('__dedicatedMobileLayout'))
    expect(batch.body.indexOf('__dedicatedMobileLayout')).toBeLessThan(batch.body.indexOf('feature.js'))

    const compressed = await request(instance.address().port, path, {
      headers: { ...headers, 'accept-encoding': 'gzip' },
    })
    expect(compressed.status).toBe(200)
    expect(compressed.headers['content-encoding']).toBe('gzip')
    expect(compressed.headers.vary).toBe('Accept-Encoding')
    expect(compressed.headers.etag).toMatch(/^[a-f\d]{64}-gzip$/u)
    expect(gunzipSync(compressed.rawBody)).toEqual(batch.rawBody)
    expect(compressed.rawBody.byteLength).toBeLessThan(batch.rawBody.byteLength)

    const compressedCached = await request(instance.address().port, path, {
      headers: {
        ...headers,
        'accept-encoding': 'gzip',
        'if-none-match': String(compressed.headers.etag),
      },
    })
    expect(compressedCached.status).toBe(304)
    expect(compressedCached.headers.vary).toBe('Accept-Encoding')
    expect(compressedCached.headers['cache-control']).toBe('private, max-age=31536000, immutable')

    const cached = await request(instance.address().port, path, {
      headers: { ...headers, 'if-none-match': String(batch.headers.etag) },
    })
    expect(cached.status).toBe(304)
    const unauthenticated = await request(instance.address().port, path, { headers: browserHeaders(instance) })
    expect(unauthenticated.status).toBe(401)
    expect(inner.observations.map(observation => observation.url)).toContain('/plugins/renderer.js?rev=renderer')
    expect(inner.observations.map(observation => observation.url)).toContain('/plugins/feature.js?rev=feature')
    expect(inner.observations.map(observation => observation.url)).not.toContain('/plugins/layout.js?rev=layout')
    expect(inner.observations.map(observation => observation.url)).not.toContain('/plugins/application.js?rev=stock')
  })

  it('registers the opt-in static cache Service Worker from the mobile index', async () => {
    const inner = await upstream('batched')
    const directory = await tempDirectory('dsh-mobile-sw-on-')
    const mobileLayoutFile = join(directory, 'mobile-layout.js')
    await writeFile(mobileLayoutFile, 'globalThis.__dedicatedMobileLayout = true;\n', 'utf8')
    const instance = await gateway(inner.port, { mobileLayoutFile, staticCacheWorker: true })
    const paired = await signIn(instance)
    const headers = {
      ...browserHeaders(instance),
      accept: 'text/html,application/xhtml+xml',
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    const mobile = await request(instance.address().port, '/', { headers })
    expect(mobile.status).toBe(200)
    expect(mobile.body).toContain('navigator.serviceWorker.register')
    expect(mobile.body).toContain('/mobile-access/sw.js')

    const worker = await request(instance.address().port, '/mobile-access/sw.js', { headers })
    expect(worker.status).toBe(200)
    expect(worker.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(worker.headers['cache-control']).toBe('no-store')
    expect(worker.headers['service-worker-allowed']).toBe('/')
    expect(worker.body).toContain('dshm-static-v1')
    expect(worker.body).toContain('/mobile-access/mobile-boot/')
    expect(inner.observations.map(observation => observation.url)).toEqual(['/'])
  })

  it('keeps the static cache worker disabled by default', async () => {
    const inner = await upstream('batched')
    const directory = await tempDirectory('dsh-mobile-sw-off-')
    const mobileLayoutFile = join(directory, 'mobile-layout.js')
    await writeFile(mobileLayoutFile, 'globalThis.__dedicatedMobileLayout = true;\n', 'utf8')
    const instance = await gateway(inner.port, { mobileLayoutFile })
    const paired = await signIn(instance)
    const headers = {
      ...browserHeaders(instance),
      accept: 'text/html,application/xhtml+xml',
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    const mobile = await request(instance.address().port, '/', { headers })
    expect(mobile.status).toBe(200)
    expect(mobile.body).not.toContain('navigator.serviceWorker')

    const worker = await request(instance.address().port, '/mobile-access/sw.js', { headers })
    expect(worker.status).toBe(404)
  })

  it('keeps the DSH 0.1.2 browser-auth cookie inside the authenticated mobile gateway', async () => {
    const inner = await upstream('batched', true)
    const authenticatedUrl = `http://127.0.0.1:${String(inner.port)}/?token=${UPSTREAM_LAUNCH_TOKEN}`
    const instance = await gateway(inner.port, {}, undefined, authenticatedUrl)
    const paired = await signIn(instance)
    const headers = {
      ...browserHeaders(instance),
      accept: 'text/html,application/xhtml+xml',
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    const mobile = await request(instance.address().port, '/', { headers })
    expect(mobile.status).toBe(200)
    expect(mobile.headers['set-cookie']).toBeUndefined()
    const asset = await request(instance.address().port, '/assets/app.js', { headers })
    expect(asset.status).toBe(200)
    expect(asset.headers['set-cookie']).toBeUndefined()
    const opened = await openWebSocket(instance, '/api/remote.mux', paired.session)
    expect(opened.response).toContain('101 Switching Protocols')
    opened.socket.destroy()

    expect(inner.observations.filter(observation => observation.url?.includes('token=')).length).toBe(1)
    for (const observed of inner.observations.filter(observation => !observation.url.includes('token='))) {
      expect(observed.headers.cookie).toBe(UPSTREAM_BROWSER_COOKIE)
    }
    expect(inner.upgradeObservations).toHaveLength(1)
    expect(inner.upgradeObservations[0]?.cookie).toBe(UPSTREAM_BROWSER_COOKIE)
  })

  it('keeps account and token management on a loopback Host-fenced route', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const route = instance.localAdminRoute()
    const adminServer = createServer((incoming, response) => {
      void route.handler(incoming, response)
    })
    const adminPort = await listen(adminServer)
    cleanups.push(() => closeServer(adminServer))
    const host = `127.0.0.1:${String(adminPort)}`

    // Host 围栏：非回环 Host（DNS rebinding 用的域名与 LAN IP）一律 403。
    const rebound = await request(adminPort, '/api/mobile-access/status', {
      headers: { host: 'attacker.example' },
    })
    expect(rebound.status).toBe(403)
    const lanHost = await request(adminPort, '/api/mobile-access/status', {
      headers: { host: '192.168.0.5' },
    })
    expect(lanHost.status).toBe(403)

    // 旧的配对/设备面已整体删除。
    for (const removed of ['/api/mobile-access/pairing/open', '/api/mobile-access/devices']) {
      const gone = await request(adminPort, removed, {
        method: removed.endsWith('open') ? 'POST' : 'GET',
        headers: { host, 'content-type': 'application/json' },
        ...(removed.endsWith('open') ? { body: '{}' } : {}),
      })
      expect(gone.status).toBe(404)
    }

    // 设账号（回环管理面）→ 登录拿一枚 token → 列表 → 按 id / all 撤销。
    const created = await request(adminPort, '/api/mobile-access/account', {
      method: 'POST',
      headers: { host, 'content-type': 'application/json' },
      body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD }),
    })
    expect(created.status).toBe(200)
    expect(JSON.parse(created.body)).toMatchObject({ configured: true, username: TEST_USERNAME })
    expect(created.body).not.toContain(TEST_PASSWORD)

    const issued = await request(instance.address().port, '/mobile-access/auth/login', {
      method: 'POST',
      headers: { ...browserHeaders(instance), 'content-type': 'application/json' },
      body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD, label: 'Managed phone' }),
    })
    expect(issued.status).toBe(200)
    const issuedBody = JSON.parse(issued.body) as { token: string; tokenId: string }

    const listed = await request(adminPort, '/api/mobile-access/tokens', { headers: { host } })
    expect(listed.status).toBe(200)
    expect(JSON.parse(listed.body)).toMatchObject({
      account: TEST_USERNAME,
      tokens: [expect.objectContaining({ id: issuedBody.tokenId, label: 'Managed phone' })],
    })
    expect(listed.body).not.toContain('tokenDigest')
    expect(listed.body).not.toContain(issuedBody.token)

    // 管理面状态回的是账号口径，不再有 pairing / deviceCount。
    const status = await request(adminPort, '/api/mobile-access/status', { headers: { host } })
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body)).toMatchObject({
      accountConfigured: true,
      tokenCount: 1,
      resources: {
        connections: expect.any(Number),
        activeRequests: expect.any(Number),
        webSockets: expect.any(Number),
      },
      gateway: { host: '127.0.0.1', port: instance.address().port, origin: instance.address().origin },
    })
    expect(JSON.parse(status.body)).not.toHaveProperty('pairing')
    expect(JSON.parse(status.body)).not.toHaveProperty('deviceCount')

    const revoked = await request(adminPort, '/api/mobile-access/tokens/revoke', {
      method: 'POST',
      headers: { host, 'content-type': 'application/json' },
      body: JSON.stringify({ id: issuedBody.tokenId }),
    })
    expect(revoked.status).toBe(200)
    expect(JSON.parse(revoked.body)).toEqual({ revoked: 1 })

    // 再登录两枚，然后用 `{all:true}` 把这 2 枚活跃 token 一并踢掉。
    for (const label of ['Second phone', 'Third phone']) {
      const extra = await request(instance.address().port, '/mobile-access/auth/login', {
        method: 'POST',
        headers: { ...browserHeaders(instance), 'content-type': 'application/json' },
        body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD, label }),
      })
      expect(extra.status).toBe(200)
    }
    const revokedAll = await request(adminPort, '/api/mobile-access/tokens/revoke', {
      method: 'POST',
      headers: { host, 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    })
    expect(revokedAll.status).toBe(200)
    expect(JSON.parse(revokedAll.body)).toEqual({ revoked: 2 })
    const afterAll = await request(adminPort, '/api/mobile-access/tokens', { headers: { host } })
    expect(JSON.parse(afterAll.body).tokens.every((token: { revokedAt?: number }) => typeof token.revokedAt === 'number')).toBe(true)
  })

  it('never trusts X-Forwarded-For for login rate-limit identity', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port, {}, undefined, undefined, { maxLoginAttempts: 2 })
    await configureAccount(instance)
    const statuses: number[] = []
    for (const forwarded of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      const attempted = await request(instance.address().port, '/mobile-access/auth/login', {
        method: 'POST',
        headers: {
          ...browserHeaders(instance),
          'content-type': 'application/json',
          'x-forwarded-for': forwarded,
        },
        body: JSON.stringify({ username: TEST_USERNAME, password: 'not-the-password' }),
      })
      statuses.push(attempted.status)
    }
    expect(statuses).toEqual([401, 401, 429])
  })

  it('signs in with the account password and carries one credential across every route', async () => {
    const inner = await upstream()
    const instanceId = 'a'.repeat(64)
    const instance = await gateway(inner.port, { instanceId })
    const discovered = await request(instance.address().port, '/mobile-access/discovery', {
      headers: { host: new URL(instance.address().origin).host },
    })
    expect(discovered.status).toBe(200)
    expect(JSON.parse(discovered.body)).toEqual({
      deviceName: expect.any(String),
      origin: instance.address().origin,
      port: instance.address().port,
      protocol: 1,
      instanceId,
    })
    await expect(udpDiscovery(instance.address().port)).resolves.toEqual({
      deviceName: expect.any(String),
      origin: instance.address().origin,
      port: instance.address().port,
      protocol: 1,
      instanceId,
    })

    const base = browserHeaders(instance)
    const port = instance.address().port
    const password = 'hmw-correct-horse-battery'

    // 账号还没设：登录必须明确说「未配置」，而不是含糊的 401。
    const unconfigured = await request(port, '/mobile-access/auth/login', {
      method: 'POST',
      headers: { ...base, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'feiyueve', password }),
    })
    expect(unconfigured.status).toBe(409)

    // 服务端（回环管理面）写账号；明文密码绝不回显、绝不落库。
    const route = instance.localAdminRoute()
    const adminServer = createServer((incoming, response) => { void route.handler(incoming, response) })
    const adminPort = await listen(adminServer)
    cleanups.push(() => closeServer(adminServer))
    const adminHost = `127.0.0.1:${String(adminPort)}`
    const created = await request(adminPort, '/api/mobile-access/account', {
      method: 'POST',
      headers: { host: adminHost, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'feiyueve', password }),
    })
    expect(created.status).toBe(200)
    expect(created.body).not.toContain(password)

    const rejected = await request(port, '/mobile-access/auth/login', {
      method: 'POST',
      headers: { ...base, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'feiyueve', password: 'not-the-password' }),
    })
    expect(rejected.status).toBe(401)
    const wrongUser = await request(port, '/mobile-access/auth/login', {
      method: 'POST',
      headers: { ...base, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'someone-else', password }),
    })
    expect(wrongUser.status).toBe(401)

    const login = await request(port, '/mobile-access/auth/login', {
      method: 'POST',
      headers: { ...base, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'feiyueve', password, label: 'Pixel' }),
    })
    expect(login.status).toBe(200)
    const issued = JSON.parse(login.body) as { token: string; csrfToken: string; expiresAt: number; tokenId: string }
    expect(issued.token).toMatch(/^[\w-]{43}$/u)
    expect(issued.csrfToken).toMatch(/^[\w-]{43}$/u)
    // 「一个月」是判据：至少 29 天，且落盘可跨重启（见 account.test.ts）。
    expect(issued.expiresAt - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60_000)
    expect(String(login.headers['set-cookie'])).toContain(`dsh_ma_session=${issued.token}`)

    // 原生 API：Bearer 直接过（App 那条路）。
    const session = await request(port, '/mobile-access/auth/session', {
      headers: { ...base, authorization: `Bearer ${issued.token}` },
    })
    expect(session.status).toBe(200)
    expect(JSON.parse(session.body)).toMatchObject({ ok: true, kind: 'account', username: 'feiyueve', label: 'Pixel' })

    // WebView：同名 cookie 也过——同一枚 token 的两种形态，不是两套凭据。
    const viaCookie = await request(port, '/mobile-access/auth/session', {
      headers: { ...base, cookie: `dsh_ma_session=${issued.token}` },
    })
    expect(viaCookie.status).toBe(200)

    // 无关的 Authorization 头不该抢在 cookie 前面（上游白名单会把它剥掉）。
    const cookieWins = await request(port, '/mobile-access/auth/session', {
      headers: { ...base, cookie: `dsh_ma_session=${issued.token}`, authorization: 'Bearer must-strip' },
    })
    expect(cookieWins.status).toBe(200)

    const tokens = await request(port, '/mobile-access/auth/tokens', {
      headers: { ...base, authorization: `Bearer ${issued.token}` },
    })
    expect(tokens.status).toBe(200)
    expect(tokens.body).toContain('Pixel')
    expect(tokens.body).not.toContain(issued.token)

    // 变更请求要 CSRF；撤销自己之后立刻失效。
    const withoutCsrf = await request(port, '/mobile-access/auth/tokens/revoke', {
      method: 'POST',
      headers: { ...base, authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(withoutCsrf.status).toBe(403)
    const revoked = await request(port, '/mobile-access/auth/tokens/revoke', {
      method: 'POST',
      headers: {
        ...base,
        authorization: `Bearer ${issued.token}`,
        'content-type': 'application/json',
        'x-dsh-mobile-csrf': issued.csrfToken,
      },
      body: '{}',
    })
    expect(revoked.status).toBe(200)
    const afterRevoke = await request(port, '/mobile-access/auth/session', {
      headers: { ...base, authorization: `Bearer ${issued.token}` },
    })
    expect(afterRevoke.status).toBe(401)
  })

  /**
   * 2026-10-11 实测踩到的坑：把 body 写成 `{tokenId}`（正确键是 `id`）时，旧实现会落进
   * 「省略 id 就撤销自己」那条兜底——回 `{"ok":true,"revoked":1}` 却把**调用方自己**撤了，
   * 之后每个请求 401。看起来像「撤销不可靠」，实际是请求把自己踢下线了。
   */
  it('撤销接口只认 id/all/self：拼错的键必须 400，绝不静默撤销调用方自己', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const port = instance.address().port
    const base = browserHeaders(instance)
    const caller = await signIn(instance, 'Caller')
    const other = await signIn(instance, 'Other phone')
    const mutation = (session: { token: string; csrf: string }): Record<string, string> => ({
      ...base,
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
      'x-dsh-mobile-csrf': session.csrf,
    })
    const alive = async (session: { token: string }): Promise<number> =>
      (await request(port, '/mobile-access/auth/session', {
        headers: { ...base, authorization: `Bearer ${session.token}` },
      })).status

    const typo = await request(port, '/mobile-access/auth/tokens/revoke', {
      method: 'POST',
      headers: mutation(caller),
      body: JSON.stringify({ tokenId: other.tokenId }),
    })
    expect(typo.status).toBe(400)
    expect(await alive(caller)).toBe(200)
    expect(await alive(other)).toBe(200)

    const revoked = await request(port, '/mobile-access/auth/tokens/revoke', {
      method: 'POST',
      headers: mutation(caller),
      body: JSON.stringify({ id: other.tokenId }),
    })
    expect(revoked.status).toBe(200)
    expect(await alive(other)).toBe(401)
    expect(await alive(caller)).toBe(200)

    const missing = await request(port, '/mobile-access/auth/tokens/revoke', {
      method: 'POST',
      headers: mutation(caller),
      body: JSON.stringify({ id: '0'.repeat(32) }),
    })
    expect(missing.status).toBe(404)

    const self = await request(port, '/mobile-access/auth/tokens/revoke', {
      method: 'POST',
      headers: mutation(caller),
      body: JSON.stringify({ self: true }),
    })
    expect(self.status).toBe(200)
    expect(await alive(caller)).toBe(401)
  })

  it('keeps discovery metadata-only and offers the CA on a separate endpoint', async () => {
    const inner = await upstream()
    const files = await tlsFixtureFiles()
    const root = new X509Certificate(await readFile(files.root))
    const instanceId = root.fingerprint256.replaceAll(':', '').toLowerCase()
    const instance = await gateway(inner.port, {
      instanceId,
      pairingCaFile: files.root,
      tls: { mode: 'provided', certFile: files.leaf, keyFile: files.key, caFile: files.intermediate },
    })
    const discovered = await udpDiscovery(instance.address().port)
    expect(Object.keys(discovered).sort()).toEqual(['deviceName', 'instanceId', 'origin', 'port', 'protocol'])
    const certificate = await trustedHttpsRequest(instance.address().port, '/mobile-access/ca.cer', await readFile(files.root, 'utf8'))
    expect(certificate.status).toBe(200)
    expect(certificate.headers['content-type']).toBe('application/pkix-cert')
    expect(certificate.rawBody).toEqual(root.raw)
  })

  it('publishes version compatibility separately from the stable discovery protocol', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const metadata = await request(instance.address().port, '/mobile-access/metadata', {
      headers: { host: new URL(instance.address().origin).host },
    })

    expect(metadata.status).toBe(200)
    expect(JSON.parse(metadata.body)).toEqual({
      version: 1,
      accountConfigured: false,
      pluginVersion: DSH_MOBILE_VERSION,
      minimumAndroidAppVersion: MINIMUM_ANDROID_APP_VERSION,
      discoveryProtocol: 1,
    })
  })

  it('signs in only from the exact origin, hides local admin, and preserves authenticated remote authority', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const base = browserHeaders(instance)

    // 变更请求（登录也是 POST）必须在精确 Host + 精确 Origin + 同源 Fetch Metadata 下才放行。
    const wrongHost = await request(instance.address().port, '/mobile-access/auth/login', {
      method: 'POST',
      headers: { ...base, host: 'attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD }),
    })
    expect(wrongHost.status).toBe(403)
    const wrongOrigin = await request(instance.address().port, '/mobile-access/auth/login', {
      method: 'POST',
      headers: { ...base, origin: 'http://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD }),
    })
    expect(wrongOrigin.status).toBe(403)

    const issued = await configureAccount(instance)
    expect(issued.hasAccount()).toBe(true)
    // 登录响应就带网关自有的安全头（与旧配对响应同口径）。
    const loginResponse = await request(instance.address().port, '/mobile-access/auth/login', {
      method: 'POST',
      headers: { ...base, 'content-type': 'application/json' },
      body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD, label: 'Phone' }),
    })
    expect(loginResponse.status).toBe(200)
    expect(loginResponse.headers['strict-transport-security']).toBeUndefined()
    expect(loginResponse.headers['content-security-policy']).toContain("default-src 'self'")
    expect(loginResponse.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'")
    expect(loginResponse.headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'")
    const body = JSON.parse(loginResponse.body) as { csrfToken: string; token: string }
    const session = cookiesByName(loginResponse.headers).get(SESSION_COOKIE) ?? ''
    expect(session).toBe(body.token)
    expect(session).toMatch(/^[\w-]{43}$/u)

    const admin = await request(instance.address().port, '/api/mobile-access/status', { headers: base })
    expect(admin.status).toBe(404)
    const anonymous = await request(instance.address().port, '/', { headers: base })
    expect(anonymous.status).toBe(401)
    const rejectedPost = await request(instance.address().port, '/api/run', {
      method: 'POST',
      headers: { host: base.host!, cookie: `${SESSION_COOKIE}=${session}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(rejectedPost.status).toBe(403)

    const rejectedPluginPost = await request(instance.address().port, '/dsh-market/update', {
      method: 'POST',
      headers: { ...base, cookie: `${SESSION_COOKIE}=${session}`, 'content-type': 'application/json' },
      body: '{"name":"dshmarket"}',
    })
    expect(rejectedPluginPost.status).toBe(403)

    const proxied = await request(instance.address().port, '/api/run?value=1', {
      method: 'POST',
      headers: {
        ...base,
        authorization: 'Bearer must-strip',
        cookie: `${SESSION_COOKIE}=${session}; upstream=must-strip`,
        'content-type': 'application/json',
        [CSRF_HEADER]: body.csrfToken,
        'x-forwarded-for': '203.0.113.5',
      },
      body: '{"task":"test"}',
    })
    expect(proxied.status).toBe(200)
    expect(proxied.headers['set-cookie']).toBeUndefined()
    expect(proxied.headers['x-powered-by']).toBeUndefined()
    expect(proxied.headers['cache-control']).toBe('no-store')
    expect(proxied.headers.expires).toBeUndefined()
    expect(proxied.headers.pragma).toBeUndefined()
    expect(inner.observations).toHaveLength(1)
    const observed = inner.observations[0]!
    expect(observed.headers.host).toBe(`127.0.0.1:${String(inner.port)}`)
    expect(observed.headers.origin).toBe(`http://127.0.0.1:${String(inner.port)}`)
    expect(observed.headers.authorization).toBeUndefined()
    expect(observed.headers.cookie).toBeUndefined()
    expect(observed.headers['x-forwarded-for']).toBeUndefined()
    expect(observed.body).toBe('{"task":"test"}')

    const pluginPost = await request(instance.address().port, '/dsh-market/update', {
      method: 'POST',
      headers: {
        ...base,
        cookie: `${SESSION_COOKIE}=${session}`,
        'content-type': 'application/json',
        [CSRF_HEADER]: body.csrfToken,
      },
      body: '{"name":"dshmarket"}',
    })
    expect(pluginPost.status).toBe(200)
    expect(inner.observations.at(-1)).toMatchObject({
      method: 'POST',
      url: '/dsh-market/update',
      body: '{"name":"dshmarket"}',
    })

    const staticAsset = await request(instance.address().port, '/assets/app.js', {
      headers: {
        ...base,
        authorization: 'Bearer must-strip',
        cookie: `${SESSION_COOKIE}=${session}; upstream=must-strip`,
        'x-forwarded-host': 'attacker.example',
      },
    })
    expect(staticAsset.status).toBe(200)
    expect(inner.observations).toHaveLength(3)
    const staticObservation = inner.observations.at(-1)!
    expect(staticObservation.headers.host).toBe(`127.0.0.1:${String(inner.port)}`)
    expect(staticObservation.headers.origin).toBe(`http://127.0.0.1:${String(inner.port)}`)
    expect(staticObservation.headers.cookie).toBeUndefined()
    expect(staticObservation.headers.authorization).toBeUndefined()
    expect(staticObservation.headers['x-forwarded-host']).toBeUndefined()

    const rejectedCount = inner.observations.length
    const rejectedHost = await request(instance.address().port, '/api/run', {
      method: 'POST',
      headers: {
        ...base,
        host: 'attacker.example',
        cookie: `${SESSION_COOKIE}=${session}`,
        'content-type': 'application/json',
        [CSRF_HEADER]: body.csrfToken,
      },
      body: '{}',
    })
    expect(rejectedHost.status).toBe(403)
    const rejectedOrigin = await request(instance.address().port, '/api/run', {
      method: 'POST',
      headers: {
        ...base,
        origin: 'http://attacker.example',
        cookie: `${SESSION_COOKIE}=${session}`,
        'content-type': 'application/json',
        [CSRF_HEADER]: body.csrfToken,
      },
      body: '{}',
    })
    expect(rejectedOrigin.status).toBe(403)
    expect(inner.observations).toHaveLength(rejectedCount)

    const duplicateCookie = await request(instance.address().port, '/', {
      headers: { ...base, cookie: `${SESSION_COOKIE}=${session}; ${SESSION_COOKIE}=${session}` },
    })
    expect(duplicateCookie.status).toBe(401)
  })

  it('compresses text assets when the authenticated client accepts gzip', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await signIn(instance)
    const headers = {
      ...browserHeaders(instance),
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    const compressed = await request(instance.address().port, '/plugins/compressible.js', {
      headers: { ...headers, 'accept-encoding': 'br, gzip, deflate' },
    })
    expect(compressed.status).toBe(200)
    expect(compressed.headers['content-encoding']).toBe('gzip')
    expect(compressed.headers['content-length']).toBeUndefined()
    expect(compressed.headers.etag).toBeUndefined()
    expect(compressed.headers.vary).toBe('Accept-Encoding')
    expect(gunzipSync(compressed.rawBody).toString('utf8')).toBe(COMPRESSIBLE_SCRIPT)
    expect(compressed.rawBody.length).toBeLessThan(Buffer.byteLength(COMPRESSIBLE_SCRIPT) / 4)

    const identity = await request(instance.address().port, '/plugins/compressible.js', {
      headers: { ...headers, 'accept-encoding': 'gzip;q=0, identity' },
    })
    expect(identity.status).toBe(200)
    expect(identity.headers['content-encoding']).toBeUndefined()
    expect(identity.headers['cache-control']).toBe('no-store')
    expect(identity.body).toBe(COMPRESSIBLE_SCRIPT)

    const revisioned = await request(instance.address().port, '/plugins/compressible.js?rev=content_1234', {
      headers: { ...headers, 'accept-encoding': 'gzip' },
    })
    expect(revisioned.status).toBe(200)
    expect(revisioned.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect(gunzipSync(revisioned.rawBody).toString('utf8')).toBe(COMPRESSIBLE_SCRIPT)
  })

  it('uses mobile-sized pages and compresses session history', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await signIn(instance)
    const headers = {
      ...browserHeaders(instance),
      cookie: `${SESSION_COOKIE}=${paired.session}`,
      [CSRF_HEADER]: paired.csrf,
      'content-type': 'application/json',
      'accept-encoding': 'gzip',
    }
    const historyRequest = (maxMessages: number): string => JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method: 'session.history',
      payload: { sessionId: 'session-example', maxMessages },
    })

    const compressed = await request(instance.address().port, SESSION_HISTORY_PATH, {
      method: 'POST',
      headers,
      body: historyRequest(50),
    })
    expect(compressed.status).toBe(200)
    expect(compressed.headers['content-encoding']).toBe('gzip')
    expect(compressed.headers['content-length']).toBeUndefined()
    expect(gunzipSync(compressed.rawBody).toString('utf8')).toBe(HISTORY_RESPONSE)
    const capped = inner.observations.at(-1)
    expect(capped?.url).toBe(SESSION_HISTORY_PATH)
    expect(JSON.parse(capped?.body ?? '{}')).toMatchObject({ payload: { maxMessages: 10 } })
    expect(capped?.headers['content-length']).toBe(String(Buffer.byteLength(capped?.body ?? '')))

    await request(instance.address().port, SESSION_HISTORY_PATH, {
      method: 'POST',
      headers: { ...headers, 'accept-encoding': 'identity' },
      body: historyRequest(5),
    })
    expect(JSON.parse(inner.observations.at(-1)?.body ?? '{}')).toMatchObject({ payload: { maxMessages: 5 } })
  })

  it('logs out, revokes, and never exposes credential digests on the app path', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await signIn(instance)
    const base = browserHeaders(instance)

    const logout = await request(instance.address().port, '/mobile-access/auth/logout', {
      method: 'POST',
      headers: {
        ...base,
        cookie: `${SESSION_COOKIE}=${paired.session}`,
        'content-type': 'application/json',
        [CSRF_HEADER]: paired.csrf,
      },
      body: '{}',
    })
    expect(logout.status).toBe(200)
    expect(JSON.parse(logout.body)).toEqual({ loggedOut: true })
    const cleared = logout.headers['set-cookie']?.join(';') ?? ''
    expect(cleared).toContain(`${SESSION_COOKIE}=;`)
    expect(cleared).toContain('dsh_ma_csrf=;')
    const afterLogout = await request(instance.address().port, '/', {
      headers: { ...base, cookie: `${SESSION_COOKIE}=${paired.session}` },
    })
    expect(afterLogout.status).toBe(401)
    expect(instance.tokens().find(token => token.id === paired.tokenId)?.revokedAt).toBeTypeOf('number')

    // 未登录顶层导航 → 账密表单页（不再有「Reconnect this device / 去配对」）。
    const landing = await request(instance.address().port, '/workspace/current', {
      headers: {
        ...base,
        accept: 'text/html',
        'sec-fetch-dest': 'document',
      },
    })
    expect(landing.status).toBe(302)
    expect(landing.headers.location).toBe('/mobile-access/login?return=%2Fworkspace%2Fcurrent')
    const login = await request(instance.address().port, landing.headers.location!, { headers: base })
    expect(login.status).toBe(200)
    expect(login.body).toContain('login-form')
    expect(login.body).toContain('login-username')
    expect(login.body).toContain('login-password')
    expect(login.body).toContain('/mobile-access/login.js')
    expect(login.body).not.toContain('Open pairing')
    expect(login.body).not.toContain('auth/renew')
    expect(login.body).not.toContain('Reconnect this device')
    const loginScript = await request(instance.address().port, '/mobile-access/login.js', { headers: base })
    expect(loginScript.status).toBe(200)
    expect(() => new Function(loginScript.body)).not.toThrow()
    expect(loginScript.body).toContain('/mobile-access/auth/login')
    expect(loginScript.body).toContain('resolved.origin === location.origin')

    // 「已登录设备」列表只暴露安全元数据：不含摘要、不发明文 token。
    const summaries = JSON.stringify(instance.tokens())
    expect(summaries).not.toContain('tokenDigest')
    expect(summaries).not.toContain('csrfDigest')
    expect(summaries).not.toContain(paired.token)
  })

  it('sends an unauthenticated top-level navigation to the account login page', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const base = browserHeaders(instance)

    const initial = await request(instance.address().port, '/', {
      headers: { ...base, accept: 'text/html', 'sec-fetch-dest': 'document' },
    })
    expect(initial.status).toBe(302)
    expect(initial.headers.location).toBe('/mobile-access/login?return=%2F')

    // 无凭据的登出是 401：不会误清别人的 cookie，也不会假装成功。
    const noCredential = await request(instance.address().port, '/mobile-access/auth/logout', {
      method: 'POST',
      headers: { ...base, 'content-type': 'application/json' },
    })
    expect(noCredential.status).toBe(401)

    // 一元 API 不参与 HTML 跳转：同样 401，但没有 Location。
    const apiDoesNotRedirect = await request(instance.address().port, '/api/session.list', {
      headers: { ...base, accept: 'text/html' },
    })
    expect(apiDoesNotRedirect.status).toBe(401)
    expect(apiDoesNotRedirect.headers.location).toBeUndefined()

    const paired = await signIn(instance)
    const restored = await request(instance.address().port, '/', {
      headers: { ...base, cookie: `${SESSION_COOKIE}=${paired.session}` },
    })
    expect(restored.status).toBe(200)
  })

  it.each([
    ['an appended intermediate file', (files: Awaited<ReturnType<typeof tlsFixtureFiles>>) => ({
      mode: 'provided' as const,
      certFile: files.leaf,
      keyFile: files.key,
      caFile: files.intermediate,
    })],
    ['a fullchain certificate file', (files: Awaited<ReturnType<typeof tlsFixtureFiles>>) => ({
      mode: 'provided' as const,
      certFile: files.fullchain,
      keyFile: files.key,
    })],
  ])('serves a root-trusted TLS chain from %s without requiring a client certificate', async (_name, tls) => {
    const inner = await upstream()
    const files = await tlsFixtureFiles()
    const instance = await gateway(inner.port, { tls: tls(files) })
    const response = await trustedHttpsRequest(instance.address().port, '/mobile-access/health', files.rootCert)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ ok: true })
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000')
  })

  it('rejects a self-signed root in the appended server chain', async () => {
    const inner = await upstream()
    const files = await tlsFixtureFiles()
    await expect(gateway(inner.port, {
      tls: {
        mode: 'provided',
        certFile: files.fullchain,
        keyFile: files.key,
        caFile: files.root,
      },
    })).rejects.toThrow(/must not include a self-signed root/)
  })

  it('fails closed when TLS material cannot be loaded', async () => {
    const inner = await upstream()
    const resolved = parseGatewayConfig({
      listenHost: '127.0.0.1',
      listenPort: TEST_FAILED_START_PORT,
      upstreamOrigin: `http://127.0.0.1:${String(inner.port)}`,
      publicAuthorities: ['127.0.0.1'],
      allowedCidrs: ['127.0.0.0/8'],
      stateFile: join(TMP_ROOT, `dsh-mobile-access-${randomUUID()}.json`),
      tls: {
        mode: 'provided',
        certFile: join(TMP_ROOT, `missing-${randomUUID()}.crt`),
        keyFile: join(TMP_ROOT, `missing-${randomUUID()}.key`),
      },
    })
    const account = new AccountController(new MemoryAccountStore(), new MemoryTokenStore(), {
      tokenTtlMs: DEFAULT_TOKEN_TTL_MS,
      maxTokens: 8,
      rateLimitWindowMs: 60_000,
      maxLoginAttempts: 5,
      maxRateLimitKeys: 64,
    })
    const instance = new MobileAccessGateway(resolved, account)
    await expect(instance.start()).rejects.toMatchObject({ code: 'ENOENT' })
    await instance.close()
  })

  it('aborts an in-flight proxy request and waits for listener teardown', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await signIn(instance)
    const pending = request(instance.address().port, '/hold', {
      headers: { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}` },
    }).catch(error => error as Error)
    await vi.waitFor(() => { expect(inner.observations.some(entry => entry.url === '/hold')).toBe(true) })
    await expect(instance.close()).resolves.toBeUndefined()
    await expect(Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('request remained open')), 2_000)),
    ])).resolves.toBeInstanceOf(Error)
    inner.releaseHold()
  })

  it('rejects a disallowed client CIDR before opening upstream work', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port, { allowedCidrs: ['192.0.2.0/24'] })
    // 直接发一枚「服务端真实签发」的凭据，确认拒绝来自 CIDR 围栏而不是「凭据不认识」。
    const account = accountOf(instance)
    await account.setAccount(TEST_USERNAME, TEST_PASSWORD)
    const issued = await account.login('127.0.0.1', TEST_USERNAME, TEST_PASSWORD)
    const rejected = await request(instance.address().port, '/api/run', {
      method: 'POST',
      headers: {
        ...browserHeaders(instance),
        cookie: `${SESSION_COOKIE}=${issued.token}`,
        'content-type': 'application/json',
        [CSRF_HEADER]: issued.csrfToken,
      },
      body: '{}',
    })
    expect(rejected.status).toBe(403)
    expect(inner.observations).toHaveLength(0)
  })

  it('refuses a retired device token as a credential on every carrier', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    // 先把账号立起来，确认下面拒绝的是「不认识这枚凭据」而不是「没配账号」。
    const account = await configureAccount(instance)
    const live = await signIn(instance)
    expect(account.tryAuthorize(live.token)).toBeDefined()

    const retired = randomBytes(32).toString('base64url')
    const bearer = await request(instance.address().port, '/api/session.list', {
      headers: { ...browserHeaders(instance), authorization: `Bearer ${retired}` },
    })
    expect(bearer.status).toBe(401)
    const sessionCookie = await request(instance.address().port, '/api/session.list', {
      headers: { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${retired}` },
    })
    expect(sessionCookie.status).toBe(401)
    // DEVICE_COOKIE 常量还在，但它不再是任何东西的凭据（也不是回落旁路）。
    const deviceCookie = await request(instance.address().port, '/api/session.list', {
      headers: { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${retired}; ${DEVICE_COOKIE}=${retired}` },
    })
    expect(deviceCookie.status).toBe(401)
    const deviceOnly = await request(instance.address().port, '/api/session.list', {
      headers: { ...browserHeaders(instance), cookie: `${DEVICE_COOKIE}=${retired}` },
    })
    expect(deviceOnly.status).toBe(401)
    // 真凭据照旧可用：上面的 401 是拒绝，不是路由断了。
    const authorized = await request(instance.address().port, '/api/session.list', {
      headers: { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${live.session}` },
    })
    expect(authorized.status).toBe(200)
  })

  it('no longer serves the retired pairing and renewal routes', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const base = browserHeaders(instance)
    for (const path of ['/mobile-access/auth/pair', '/mobile-access/auth/renew']) {
      const gone = await request(instance.address().port, path, {
        method: 'POST',
        headers: { ...base, 'content-type': 'application/json' },
        body: '{}',
      })
      expect(gone.status, path).toBe(404)
      expect(JSON.parse(gone.body)).toEqual({ error: 'not_found' })
    }
    const page = await request(instance.address().port, '/mobile-access/pair', { headers: base })
    expect(page.status).toBe(404)
    const script = await request(instance.address().port, '/mobile-access/pair.js', { headers: base })
    expect(script.status).toBe(404)
  })

  it('accepts an empty logout body and revokes the presented credential', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await signIn(instance)
    const base = browserHeaders(instance)
    const logout = await request(instance.address().port, '/mobile-access/auth/logout', {
      method: 'POST',
      headers: {
        ...base,
        cookie: `${SESSION_COOKIE}=${paired.session}`,
        'content-type': 'application/json',
        [CSRF_HEADER]: paired.csrf,
      },
      // 刻意不写 body：客户端 `fetch(..., {method:'POST'})` 就是这样，不该被 400 挡掉。
    })
    expect(logout.status).toBe(200)
    expect(JSON.parse(logout.body)).toEqual({ loggedOut: true })
    const reused = await request(instance.address().port, '/mobile-access/auth/session', {
      headers: { ...base, cookie: `${SESSION_COOKIE}=${paired.session}` },
    })
    expect(reused.status).toBe(401)
  })

  it('serves the app manifest with or without a cache-busting query string', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await signIn(instance)
    const headers = { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}` }
    const bare = await request(instance.address().port, '/mobile-access/app/manifest.json', { headers })
    const busted = await request(instance.address().port, '/mobile-access/app/manifest.json?x=1', { headers })
    expect(busted.status).toBe(bare.status)
    // manifest 走 APP_DISTRIBUTION_ORIGIN（127.0.0.1:8008）的本地代理；测试环境里
    // 那个 APK 分发服务通常不可达，于是拿到 502 distribution_unreachable——
    // 关键回归点是「不再 404」（查询串被忽略），不是上游一定在。
    expect(busted.status).not.toBe(404)
    if (busted.status === 502) expect(JSON.parse(busted.body)).toEqual({ error: 'distribution_unreachable' })
    else expect(busted.status).toBe(200)
    const anonymous = await request(instance.address().port, '/mobile-access/app/manifest.json?x=1', {
      headers: browserHeaders(instance),
    })
    expect(anonymous.status).toBe(401)
  })

  describe('内容热更（页面资源 + Dart 补丁）', () => {
    /**
     * 备一份热更内容目录 + 网关。
     *
     * 两个目录都通过 `overrides` 指到临时目录里，**不碰**默认位置
     * （`accountDir/hotupdate`、`accountDir/codepush`）——默认位置是真机上发布脚本
     * 写的地方，用例去那里读写会把真内容搅了。
     */
    async function hotGateway(seed: {
      assets?: Record<string, string>
      index?: Record<string, unknown>
      files?: Record<string, string | Buffer>
    } = {}): Promise<{ instance: MobileAccessGateway; port: number }> {
      const inner = await upstream()
      const root = await tempDirectory('hot-update')
      const assetsDir = join(root, 'hotupdate')
      const codePushDir = join(root, 'codepush')
      await mkdir(assetsDir, { recursive: true })
      await mkdir(codePushDir, { recursive: true })
      for (const [name, body] of Object.entries(seed.assets ?? {})) {
        const target = join(assetsDir, name)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, body)
      }
      for (const [name, body] of Object.entries(seed.files ?? {})) {
        await writeFile(join(codePushDir, name), body)
      }
      if (seed.index !== undefined) await writeFile(join(codePushDir, 'index.json'), JSON.stringify(seed.index))
      const instance = await gateway(inner.port, { hotUpdateDir: assetsDir, codePushDir })
      return { instance, port: instance.address().port }
    }

    /** 设备端 `PatchCheckRequest` 的最小体（字段名与 engine 的 serde 结构一致）。 */
    const checkBody = (over: Record<string, unknown> = {}): string => JSON.stringify({
      app_id: '5e0abe95-61fa-463f-83a9-c1ca225f2ca9',
      channel: 'stable',
      release_version: '0.5.1+144',
      platform: 'android',
      arch: 'x86_64',
      client_id: 'a9001bbd-0a00-4eb9-8c0a-10e7b16d7d93',
      ...over,
    })

    function patchIndex(patch: Record<string, unknown>): Record<string, unknown> {
      return { releases: { '0.5.1+144|android|x86_64': { patches: [patch] } } }
    }

    it('三条路由匿名一律 401（内容清单本身就是发布节奏，不能白给）', async () => {
      const { instance, port } = await hotGateway({ assets: { 'terminal/terminal.html': '<html/>' } })
      const base = browserHeaders(instance)
      const anonymous = [
        await request(port, `${APP_ASSETS_PREFIX}/manifest.json`, { headers: base }),
        await request(port, `${CODE_PUSH_PREFIX}/check`, { method: 'POST', headers: { ...base, 'content-type': 'application/json' }, body: checkBody() }),
        await request(port, `${CODE_PUSH_PREFIX}/download/patch-1.bin`, { headers: base }),
      ]
      for (const result of anonymous) {
        expect(result.status).toBe(401)
        expect(JSON.parse(result.body)).toMatchObject({ error: expect.any(String) as unknown as string })
      }
    })

    it('带会话能取到资源，且不缓存、Content-Type 按扩展名给', async () => {
      const { instance, port } = await hotGateway({
        assets: {
          'manifest.json': JSON.stringify({ revision: 7, files: {} }),
          'terminal/terminal.html': '<html>REMOTE</html>',
        },
      })
      const paired = await signIn(instance)
      const headers = { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}` }

      const manifest = await request(port, `${APP_ASSETS_PREFIX}/manifest.json`, { headers })
      expect(manifest.status).toBe(200)
      expect(manifest.headers['content-type']).toBe('application/json; charset=utf-8')
      expect(manifest.headers['cache-control']).toBe('no-store')
      expect(JSON.parse(manifest.body)).toMatchObject({ revision: 7 })

      const page = await request(port, `${APP_ASSETS_PREFIX}/terminal/terminal.html`, { headers })
      expect(page.status).toBe(200)
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(page.body).toBe('<html>REMOTE</html>')
    })

    it('路径穿越与非法逻辑名一律 404（白名单与 App 侧同源）', async () => {
      const { instance, port } = await hotGateway({ assets: { 'manifest.json': '{}' } })
      const paired = await signIn(instance)
      const headers = { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}` }
      for (const name of ['%2e%2e%2fmanifest.json', '..%2fmanifest.json', '.hidden', 'a//b', 'sub/%2e%2e/x']) {
        const result = await request(port, `${APP_ASSETS_PREFIX}/${name}`, { headers })
        expect(result.status, name).toBe(404)
      }
    })

    it('还没发布过（目录不存在）⇒ 404，绝不是 5xx（App 侧要能安静回落内置）', async () => {
      const { instance, port } = await hotGateway()
      const paired = await signIn(instance)
      const headers = { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}` }
      const missing = await request(port, `${APP_ASSETS_PREFIX}/manifest.json`, { headers })
      expect(missing.status).toBe(404)
      const patch = await request(port, `${CODE_PUSH_PREFIX}/download/patch-1.bin`, { headers })
      expect(patch.status).toBe(404)
    })

    it('check：该 release 没登记 ⇒ patch_available:false', async () => {
      const { instance, port } = await hotGateway({ index: { releases: {} } })
      const paired = await signIn(instance)
      const result = await request(port, `${CODE_PUSH_PREFIX}/check`, {
        method: 'POST',
        headers: { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}`, 'content-type': 'application/json' },
        body: checkBody(),
      })
      expect(result.status).toBe(200)
      expect(JSON.parse(result.body)).toEqual({ patch_available: false })
    })

    it('check：有新补丁 ⇒ 下发编号/hash/本网关的 download_url，签名照传', async () => {
      const { instance, port } = await hotGateway({
        index: patchIndex({ number: 3, file: 'patch-3.bin', hash: 'deadbeef', signature: 'SIG', rolled_back: false }),
        files: { 'patch-3.bin': 'PATCH-BYTES' },
      })
      const paired = await signIn(instance)
      const result = await request(port, `${CODE_PUSH_PREFIX}/check`, {
        method: 'POST',
        headers: { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}`, 'content-type': 'application/json' },
        body: checkBody({ current_patch_number: 0 }),
      })
      expect(result.status).toBe(200)
      expect(JSON.parse(result.body)).toEqual({
        patch_available: true,
        patch: {
          number: 3,
          hash: 'deadbeef',
          download_url: `http://127.0.0.1:${String(port)}${CODE_PUSH_PREFIX}/download/patch-3.bin`,
          hash_signature: 'SIG',
        },
      })

      const bytes = await request(port, `${CODE_PUSH_PREFIX}/download/patch-3.bin`, {
        headers: { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}` },
      })
      expect(bytes.status).toBe(200)
      expect(bytes.body).toBe('PATCH-BYTES')
    })

    it('check：已经在跑这一版 ⇒ 不再下发', async () => {
      const { instance, port } = await hotGateway({
        index: patchIndex({ number: 3, file: 'patch-3.bin', hash: 'h', rolled_back: false }),
      })
      const paired = await signIn(instance)
      const result = await request(port, `${CODE_PUSH_PREFIX}/check`, {
        method: 'POST',
        headers: { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}`, 'content-type': 'application/json' },
        body: checkBody({ current_patch_number: 3 }),
      })
      expect(JSON.parse(result.body)).toEqual({ patch_available: false })
    })

    it('check：被回滚的补丁不下发，但回滚清单**即使在 false 时也要带上**', async () => {
      // 哨兵：只回 patch_available:false 会让设备继续从被回滚的补丁启动
      // （上游 demo 的 v1 就踩了这个）。这条与 patch_server.py 的注释一一对应。
      const { instance, port } = await hotGateway({
        index: patchIndex({ number: 2, file: 'patch-2.bin', hash: 'h2', rolled_back: true }),
      })
      const paired = await signIn(instance)
      const result = await request(port, `${CODE_PUSH_PREFIX}/check`, {
        method: 'POST',
        headers: { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}`, 'content-type': 'application/json' },
        body: checkBody({ current_patch_number: 2 }),
      })
      expect(JSON.parse(result.body)).toEqual({
        patch_available: false,
        rolled_back_patch_numbers: [2],
      })
    })

    it('check：index.json 里越界的文件名被忽略（清单是数据，不是路径指令）', async () => {
      const { instance, port } = await hotGateway({
        index: patchIndex({ number: 9, file: '../escape.bin', hash: 'h9', rolled_back: false }),
      })
      const paired = await signIn(instance)
      const result = await request(port, `${CODE_PUSH_PREFIX}/check`, {
        method: 'POST',
        headers: { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}`, 'content-type': 'application/json' },
        body: checkBody(),
      })
      expect(JSON.parse(result.body)).toEqual({ patch_available: false })
    })

    it('events：收得下就回 200 {}；非 JSON 体一律 415', async () => {
      const { instance, port } = await hotGateway()
      const paired = await signIn(instance)
      const headers = { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}` }
      const ok = await request(port, `${CODE_PUSH_PREFIX}/events`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'patch_installed' }),
      })
      expect(ok.status).toBe(200)
      expect(JSON.parse(ok.body)).toEqual({})

      const wrongType = await request(port, `${CODE_PUSH_PREFIX}/events`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'text/plain' },
        body: 'not json',
      })
      expect(wrongType.status).toBe(415)
    })

    it('download：白名单外的名字与不存在的文件都回 404', async () => {
      const { instance, port } = await hotGateway({ files: { 'patch-1.bin': 'X' } })
      const paired = await signIn(instance)
      const headers = { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}` }
      for (const name of ['%2e%2e%2findex.json', 'nope.bin', 'patch-1.bin.bak']) {
        const result = await request(port, `${CODE_PUSH_PREFIX}/download/${name}`, { headers })
        expect(result.status, name).toBe(404)
      }
    })
  })

  it('answers an anonymous session probe without side effects and rejects revoked credentials', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const base = browserHeaders(instance)

    const anonymous = await request(instance.address().port, '/mobile-access/auth/session', { headers: base })
    expect(anonymous.status).toBe(200)
    expect(JSON.parse(anonymous.body)).toMatchObject({ ok: true, username: null, tokenId: null })
    expect(anonymous.headers['set-cookie']).toBeUndefined()

    const paired = await signIn(instance)
    const live = await request(instance.address().port, '/mobile-access/auth/session', {
      headers: { ...base, cookie: `${SESSION_COOKIE}=${paired.session}` },
    })
    expect(live.status).toBe(200)
    expect(JSON.parse(live.body)).toMatchObject({ kind: 'account', username: TEST_USERNAME })

    await accountOf(instance).revokeToken(paired.tokenId)
    const revoked = await request(instance.address().port, '/mobile-access/auth/session', {
      headers: { ...base, cookie: `${SESSION_COOKIE}=${paired.session}` },
    })
    expect(revoked.status).toBe(401)
  })

  it('rejects an expired credential at the gateway', async () => {
    const inner = await upstream()
    let clock = 1_700_000_000_000
    const instance = await gateway(inner.port, {}, undefined, undefined, { now: () => clock })
    const paired = await signIn(instance)
    const base = browserHeaders(instance)
    const live = await request(instance.address().port, '/mobile-access/auth/session', {
      headers: { ...base, cookie: `${SESSION_COOKIE}=${paired.session}` },
    })
    expect(live.status).toBe(200)

    clock += DEFAULT_TOKEN_TTL_MS + 1
    const expired = await request(instance.address().port, '/mobile-access/auth/session', {
      headers: { ...base, cookie: `${SESSION_COOKIE}=${paired.session}` },
    })
    expect(expired.status).toBe(401)
    // 过期不是「回落」：同一枚凭据在代理路径上也不再放行。
    const proxied = await request(instance.address().port, '/api/session.list', {
      headers: { ...base, cookie: `${SESSION_COOKIE}=${paired.session}` },
    })
    expect(proxied.status).toBe(401)
    expect(inner.observations).toHaveLength(0)
  })

  // 0.3.41 日志面收紧：两条日志路由的凭据都不再是「写死在源码/App 里的静态令牌」。
  it('takes the app log report on the account session and refuses static tokens', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const base = browserHeaders(instance)
    const report = JSON.stringify({ tenant: 'mobile', service: 'dsh-mobile', level: 'info', message: 'hello' })

    // 匿名 → 401（原先靠内置部署令牌就能写）
    const anonymous = await request(instance.address().port, '/mobile-access/log-report', {
      method: 'POST',
      headers: { ...base, 'content-type': 'text/plain' },
      body: report,
    })
    expect(anonymous.status).toBe(401)

    // 退役的静态令牌（部署令牌 / 页面令牌）在这条路由上都没有效力
    for (const stale of ['84153b5de2ef20c9b17b0504bafae573cb6dcd0d9cfca6bf', 'dshm-page-ingest-7f3a91c4e6b2d805']) {
      const denied = await request(instance.address().port, '/mobile-access/log-report', {
        method: 'POST',
        headers: { ...base, 'content-type': 'text/plain', 'x-log-token': stale },
        body: report,
      })
      expect(denied.status).toBe(401)
    }

    // 账号会话（Bearer 形态）→ 放行到转发步骤；本机 logstash 可达时 200，不可达 502。
    const paired = await signIn(instance)
    const allowed = await request(instance.address().port, '/mobile-access/log-report', {
      method: 'POST',
      headers: { ...base, 'content-type': 'text/plain', authorization: `Bearer ${paired.token}` },
      body: report,
    })
    expect([200, 502]).toContain(allowed.status)

    // 被撤销的凭据立刻失效
    await accountOf(instance).revokeToken(paired.tokenId)
    const revoked = await request(instance.address().port, '/mobile-access/log-report', {
      method: 'POST',
      headers: { ...base, 'content-type': 'text/plain', authorization: `Bearer ${paired.token}` },
      body: report,
    })
    expect(revoked.status).toBe(401)
  })

  it('keeps the page-guard /log-ingest route on the page token only', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const base = browserHeaders(instance)

    const anonymous = await request(instance.address().port, '/log-ingest', {
      method: 'POST',
      headers: { ...base, 'content-type': 'text/plain' },
      body: '{}',
    })
    expect(anonymous.status).toBe(403)
    // 退役的部署令牌不再放行（它就是 App 曾经内置的那一枚）
    const deployToken = await request(instance.address().port, '/log-ingest', {
      method: 'POST',
      headers: { ...base, 'content-type': 'text/plain', 'x-log-token': '84153b5de2ef20c9b17b0504bafae573cb6dcd0d9cfca6bf' },
      body: '{}',
    })
    expect(deployToken.status).toBe(403)
    // 页面令牌（部署经 __DSH_INGEST_TOKEN__ 注入，只有登录后的页面拿得到）仍放行
    const pageToken = await request(instance.address().port, '/log-ingest', {
      method: 'POST',
      headers: { ...base, 'content-type': 'text/plain', 'x-log-token': 'dshm-page-ingest-7f3a91c4e6b2d805' },
      body: '{}',
    })
    expect([200, 502]).toContain(pageToken.status)
  })

  it('gates the log query on the account session and hands upstream the in-process key', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const base = browserHeaders(instance)

    // 匿名查询 → 401（原先带 X-Log-Query 静态令牌即可读）
    const anonymous = await request(instance.address().port, '/api/mobile-logs?limit=10', { headers: base })
    expect(anonymous.status).toBe(401)
    const staleToken = await request(instance.address().port, '/api/mobile-logs?limit=10', {
      headers: { ...base, 'x-log-query': '8f2d6a41c9e7b305d4a8f1c276e5b90d' },
    })
    expect(staleToken.status).toBe(401)
    expect(inner.observations).toHaveLength(0)

    const paired = await signIn(instance)
    const allowed = await request(instance.address().port, '/api/mobile-logs?limit=10', {
      headers: { ...base, cookie: `${SESSION_COOKIE}=${paired.session}` },
    })
    expect(allowed.status).toBe(200) // 假上游是 catch-all 200：能到 200 就说明已过鉴权进了代理层
    const forwarded = inner.observations.at(-1)
    expect(forwarded?.url).toBe('/api/mobile-logs?limit=10')
    // 注入的是**进程内随机键**，而不是那枚退役的静态常量
    expect(forwarded?.headers[LOG_QUERY_HEADER]).toBe(LOG_QUERY_KEY)
    expect(LOG_QUERY_KEY).not.toBe('8f2d6a41c9e7b305d4a8f1c276e5b90d')
  })
})

describe('WebSocket gateway', () => {
  it('accepts an exact-origin Android WebView upgrade without Fetch Metadata', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await signIn(instance)
    const opened = await openWebSocket(instance, '/api/events.mux', paired.session, undefined, undefined)
    expect(opened.response).toContain('101 Switching Protocols')
    opened.socket.destroy()
  })

  it('keeps the gateway alive when a mobile WebSocket resets abruptly', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await signIn(instance)
    const opened = await openWebSocket(instance, '/api/events.mux', paired.session)
    expect(opened.response).toContain('101 Switching Protocols')
    opened.socket.resetAndDestroy()
    await new Promise(resolve => setTimeout(resolve, 50))

    const response = await request(instance.address().port, '/assets/app.js', {
      headers: {
        ...browserHeaders(instance),
        cookie: `${SESSION_COOKIE}=${paired.session}`,
      },
    })
    expect(response.status).toBe(200)
  })

  it('allows only the known DSH event and Remote paths, forwards only the Session Cookie, and closes all on revocation', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port, { maxWebSockets: 3 })
    const paired = await signIn(instance)
    const first = await openWebSocket(instance, '/api/events.mux', paired.session)
    const second = await openWebSocket(instance, '/api/events.host', paired.session)
    const third = await openWebSocket(instance, '/api/remote.mux', paired.session)
    expect(first.response).toContain('101 Switching Protocols')
    expect(second.response).toContain('101 Switching Protocols')
    expect(third.response).toContain('101 Switching Protocols')
    expect(inner.upgradeObservations).toHaveLength(3)
    for (const observed of inner.upgradeObservations) {
      expect(observed.cookie).toBeUndefined()
      expect(observed.origin).toBe(`http://127.0.0.1:${String(inner.port)}`)
      expect(observed.host).toBe(`127.0.0.1:${String(inner.port)}`)
    }

    const firstClosed = new Promise<void>(resolve => { first.socket.once('close', () => resolve()) })
    const secondClosed = new Promise<void>(resolve => { second.socket.once('close', () => resolve()) })
    const thirdClosed = new Promise<void>(resolve => { third.socket.once('close', () => resolve()) })
    // 撤销凭据（旧 `revokeDevice`）必须掐断挂在它上面的每一条长连接。
    expect(await accountOf(instance).revokeToken(paired.tokenId)).toBe(true)
    await Promise.all([firstClosed, secondClosed, thirdClosed])

    const unknown = await openWebSocket(instance, '/api/events.unknown', paired.session)
    expect(unknown.response).toContain('404')
    unknown.socket.destroy()
  })

  it('rejects a wrong WebSocket Origin on every allowed path before opening upstream work', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await signIn(instance)
    for (const path of ['/api/events.mux', '/api/events.host', '/api/remote.mux']) {
      const rejected = await openWebSocket(instance, path, paired.session, 'http://attacker.example')
      expect(rejected.response).toContain('403')
      rejected.socket.destroy()
    }
    expect(inner.upgradeObservations).toHaveLength(0)
  })

  it('closes an established WebSocket when its credential is revoked', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const account = await configureAccount(instance)
    const paired = await signIn(instance)
    const opened = await openWebSocket(instance, '/api/events.mux', paired.session)
    expect(opened.response).toContain('101 Switching Protocols')
    await account.revokeToken(paired.tokenId)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('revoked WebSocket remained open')), 1_000)
      opened.socket.once('close', () => { clearTimeout(timeout); resolve() })
    })
    await vi.waitFor(() => {
      expect(() => account.tryAuthorize(paired.session)).toThrow(/authentication_failed/u)
    })
    expect(instance.tokens().find(token => token.id === paired.tokenId)?.revokedAt).toBeTypeOf('number')
  })
})
