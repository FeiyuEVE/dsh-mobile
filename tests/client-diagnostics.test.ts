import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportClientDiagnostic, watchFileResourceProvider } from '../src/client.js'

/** The registry stand-in: one address, one status, the same read the probe makes. */
function resourcesWith(status: 'none' | 'loading' | 'live'): { source: (address: string) => { getSnapshot: () => { status: string } } } {
  return { source: (address: string) => ({ getSnapshot: () => ({ status: address.includes('dsh-resource://file/') ? status : 'none' }) }) }
}

interface FakeContext {
  readonly get: (name: string) => unknown
}

function context(resources: unknown): FakeContext {
  return { get: (name: string) => (name === 'resources' ? resources : undefined) }
}

function ingest(): { url: string; body: Record<string, unknown>; token: string | undefined }[] {
  return (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.map(([url, init]) => ({
    url,
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
    token: (init.headers as Record<string, string>)['x-log-token'],
  }))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('mobile client diagnostics', () => {
  it('reports a missing file provider once, after a confirming second check', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('location', { origin: 'https://phone.example:18443', pathname: '/' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))

    const dispose = watchFileResourceProvider(context(resourcesWith('none')) as never)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(ingest()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(30_000)

    const calls = ingest()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('/log-ingest')
    expect(calls[0]?.body).toMatchObject({
      dsh_component: 'client-error',
      service: 'dsh-web-client',
      source: 'frontend',
      kind: 'resource-provider-missing',
      protocol: 'file',
      url: 'https://phone.example:18443/',
    })
    dispose()
  })

  it('stays silent while the provider is registered', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('location', { origin: 'https://phone.example:18443', pathname: '/' })
    const send = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', send)

    watchFileResourceProvider(context(resourcesWith('loading')) as never)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(send).not.toHaveBeenCalled()
  })

  it('reports an absent resource model instead of parking the plugin on it', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('location', { origin: 'http://192.168.0.240:3080', pathname: '/' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))

    watchFileResourceProvider(context(undefined) as never)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(ingest()[0]?.body).toMatchObject({ kind: 'resource-service-missing' })
  })

  it('carries the page ingest token and never reports a token-bearing url', () => {
    vi.stubGlobal('location', { origin: 'http://192.168.0.240:3080', pathname: '/' })
    vi.stubGlobal('__DSH_INGEST_TOKEN__', 'page-token')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))

    reportClientDiagnostic({ kind: 'probe', message: 'why' })
    const calls = ingest()
    expect(calls[0]?.token).toBe('page-token')
    expect(JSON.stringify(calls[0]?.body)).not.toContain('?token=')
  })

  it('swallows a delivery failure', () => {
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:3080', pathname: '/' })
    vi.stubGlobal('fetch', () => { throw new Error('offline') })
    expect(() => { reportClientDiagnostic({ kind: 'probe', message: 'why' }) }).not.toThrow()
  })
})
