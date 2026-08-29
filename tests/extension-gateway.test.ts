import { Context } from '@deepseek-ai/cordis'
import { createServer, request as requestHttp, type ClientRequest, type IncomingMessage } from 'node:http'
import type { AddressInfo, Server } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { MobileAccessService } from '../src/extensions.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { CSRF_HEADER, SESSION_COOKIE } from '../src/http-security.js'
import { MemoryDeviceStore } from '../src/storage.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function request(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const body = options.body
    const headers = { ...options.headers, ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }) }
    const outgoing = requestHttp({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers, agent: false }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.once('error', reject); outgoing.end(body)
  })
}

function cookie(headers: Record<string, string | string[] | undefined>, name: string): string {
  const values = headers['set-cookie']; const list = Array.isArray(values) ? values : values === undefined ? [] : [values]
  return list.find(value => value.startsWith(`${name}=`))?.split(';', 1)[0] ?? ''
}

function pendingRequest(port: number, path: string, method: string, headers: Record<string, string>): {
  outgoing: ClientRequest
  result: Promise<{ status: number; body: string }>
} {
  let settle: ((response: IncomingMessage) => void) | undefined
  let fail: ((error: Error) => void) | undefined
  const received = new Promise<IncomingMessage>((resolve, reject) => { settle = resolve; fail = reject })
  const outgoing = requestHttp({ host: '127.0.0.1', port, path, method, headers, agent: false }, response => settle?.(response))
  outgoing.once('error', error => fail?.(error))
  const result = received.then(response => new Promise<{ status: number; body: string }>((resolve) => {
    const chunks: Buffer[] = []
    response.on('data', chunk => chunks.push(Buffer.from(chunk)))
    response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
  }))
  return { outgoing, result }
}

describe('gateway extension namespace', () => {
  it('authenticates actions and routes while keeping the upstream proxy intact', async () => {
    const upstream = createServer((_, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><script>window.__DSH_BOOT__ = {"rev":"x","entries":[{"id":"@deepseek-ai/dsh-client-ui-layout","url":"/layout.js","rev":"x","inject":["@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-theme"]}]};</script>') })
    const upstreamPort = await listen(upstream)
    cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-gateway-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const context = new Context(); cleanups.push(() => context.fiber.dispose())
    const service = new MobileAccessService(context)
    service.registerExtension({
      schemaVersion: 1, id: 'hello', name: 'Hello', version: '1.0.0',
      actions: { echo: { run: async (_context, input) => ({ input }) } },
      routes: [{ method: 'GET', path: 'status', handle: async () => ({ contentType: 'application/json', body: JSON.stringify({ ok: true }) }) }],
    })
    const config = parseGatewayConfig({ listenHost: '127.0.0.1', listenPort: 38082, upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`, publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'], stateFile: join(directory, 'devices.json'), tls: { mode: 'disabled' } })
    const gateway = new MobileAccessGateway(config, new MemoryDeviceStore(), service)
    await gateway.start(); cleanups.push(() => gateway.close())
    const opened = await gateway.access.openPairing()
    const origin = gateway.address().origin
    const paired = await request(gateway.address().port, '/mobile-access/auth/pair', { method: 'POST', headers: { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify({ token: opened.token }) })
    expect(paired.status).toBe(201)
    const session = cookie(paired.headers, SESSION_COOKIE); const csrf = JSON.parse(paired.body) as { csrfToken: string }
    const headers = { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', cookie: session, [CSRF_HEADER]: csrf.csrfToken, 'content-type': 'application/json' }
    const action = await request(gateway.address().port, '/mobile-access/extensions/hello/actions/echo', { method: 'POST', headers, body: JSON.stringify({ value: 1 }) })
    expect(action.status).toBe(200); expect(JSON.parse(action.body)).toEqual({ input: { value: 1 } })
    const route = await request(gateway.address().port, '/mobile-access/extensions/hello/routes/status', { headers })
    expect(route.status).toBe(200); expect(JSON.parse(route.body)).toEqual({ ok: true })
  })

  it('admits extension bodies before buffering and rejects oversized declarations first', async () => {
    const upstream = createServer((_, response) => { response.writeHead(200); response.end('ok') })
    const upstreamPort = await listen(upstream)
    cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-admission-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const context = new Context(); cleanups.push(() => context.fiber.dispose())
    const service = new MobileAccessService(context)
    service.registerExtension({
      schemaVersion: 1, id: 'hello', name: 'Hello', version: '1.0.0',
      actions: { echo: { run: async (_context, input) => ({ input }) } },
      routes: [{ method: 'POST', path: 'echo', handle: async request => ({ contentType: 'application/octet-stream', body: request.body }) }],
    })
    const config = parseGatewayConfig({
      listenHost: '127.0.0.1', listenPort: 38085,
      upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`,
      publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
      stateFile: join(directory, 'devices.json'), tls: { mode: 'disabled' },
      maxActiveRequests: 1, maxBodyBytes: 1024,
    })
    const gateway = new MobileAccessGateway(config, new MemoryDeviceStore(), service)
    await gateway.start(); cleanups.push(() => gateway.close())
    const opened = await gateway.access.openPairing()
    const origin = gateway.address().origin
    const paired = await request(gateway.address().port, '/mobile-access/auth/pair', {
      method: 'POST',
      headers: { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ token: opened.token }),
    })
    const session = cookie(paired.headers, SESSION_COOKIE); const csrf = JSON.parse(paired.body) as { csrfToken: string }
    const headers = {
      host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', cookie: session,
      [CSRF_HEADER]: csrf.csrfToken, 'content-type': 'application/json',
    }

    const completeBody = JSON.stringify({ value: 1 })
    const first = pendingRequest(gateway.address().port, '/mobile-access/extensions/hello/actions/echo', 'POST', {
      ...headers, 'content-length': String(Buffer.byteLength(completeBody)),
    })
    cleanups.push(async () => { first.outgoing.destroy() })
    first.outgoing.write(completeBody.slice(0, 1))
    await new Promise(resolve => setTimeout(resolve, 25))

    const oversizedAction = pendingRequest(gateway.address().port, '/mobile-access/extensions/hello/actions/echo', 'POST', {
      ...headers, 'content-length': String(1024 * 1024 + 1),
    })
    oversizedAction.outgoing.flushHeaders()
    expect((await oversizedAction.result).status).toBe(413)
    oversizedAction.outgoing.destroy()

    const oversizedRoute = pendingRequest(gateway.address().port, '/mobile-access/extensions/hello/routes/echo', 'POST', {
      ...headers, 'content-length': '1025',
    })
    oversizedRoute.outgoing.flushHeaders()
    expect((await oversizedRoute.result).status).toBe(413)
    oversizedRoute.outgoing.destroy()

    const competing = await request(gateway.address().port, '/mobile-access/extensions/hello/routes/echo', {
      method: 'POST', headers, body: '{}',
    })
    expect(competing.status).toBe(429)
    expect(JSON.parse(competing.body)).toEqual({ error: 'busy' })

    first.outgoing.end(completeBody.slice(1))
    const completed = await first.result
    expect(completed.status).toBe(200)
    expect(JSON.parse(completed.body)).toEqual({ input: { value: 1 } })
  })

  it('serves the extension manifest on the canonical path the client requests', async () => {
    const upstream = createServer((_, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><script>window.__DSH_BOOT__ = {"rev":"x","entries":[{"id":"@deepseek-ai/dsh-client-ui-layout","url":"/layout.js","rev":"x","inject":["@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-theme"]}]};</script>') })
    const upstreamPort = await listen(upstream)
    cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-manifest-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const context = new Context(); cleanups.push(() => context.fiber.dispose())
    const service = new MobileAccessService(context)
    service.registerExtension({ schemaVersion: 1, id: 'hello', name: 'Hello', version: '1.0.0' })
    const config = parseGatewayConfig({ listenHost: '127.0.0.1', listenPort: 38084, upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`, publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'], stateFile: join(directory, 'devices.json'), tls: { mode: 'disabled' } })
    const gateway = new MobileAccessGateway(config, new MemoryDeviceStore(), service)
    await gateway.start(); cleanups.push(() => gateway.close())
    const opened = await gateway.access.openPairing()
    const origin = gateway.address().origin
    const paired = await request(gateway.address().port, '/mobile-access/auth/pair', { method: 'POST', headers: { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify({ token: opened.token }) })
    const session = cookie(paired.headers, SESSION_COOKIE)
    const headers = { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', cookie: session, 'content-type': 'application/json' }
    const manifest = await request(gateway.address().port, '/mobile-access/extensions/manifest', { headers })
    expect(manifest.status).toBe(200)
    expect(JSON.parse(manifest.body)).toMatchObject({
      protocol: 1,
      extensions: [{ id: 'hello' }],
      legacy: { scriptRevision: expect.any(String), styleRevision: expect.any(String) },
    })
    expect(manifest.headers.etag).toBeTruthy()
    const notModified = await request(gateway.address().port, '/mobile-access/extensions/manifest', { headers: { ...headers, 'if-none-match': String(manifest.headers.etag) } })
    expect(notModified.status).toBe(304)
    await writeFile(join(directory, 'mobile.js'), 'window.dshMobile?.register(() => undefined)\n// changed\n')
    const customized = await request(gateway.address().port, '/mobile-access/extensions/manifest', { headers: { ...headers, 'if-none-match': String(manifest.headers.etag) } })
    expect(customized.status).toBe(200)
    expect(JSON.parse(customized.body)).not.toMatchObject({ legacy: JSON.parse(manifest.body).legacy })
  })
})
