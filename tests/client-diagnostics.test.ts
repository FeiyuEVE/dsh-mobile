import { afterEach, describe, expect, it, vi } from 'vitest'
import { addressParseState, loaderState, reportClientDiagnostic, reportMobilePageState, watchFileResourceProvider, watchMobilePageState } from '../src/client.js'

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

/** One preview tab's DOM face: only the two attributes the diagnostic reads. */
function tab(address: string, state: string): { getAttribute: (name: string) => string | null } {
  return { getAttribute: (name: string) => (name === 'data-textpreview-url' ? address : name === 'data-textpreview-state' ? state : null) }
}

/** Everything `reportMobilePageState` reads outside the context. */
function stubPage(elements: unknown[], innerText = ''): void {
  vi.stubGlobal('document', { querySelectorAll: () => elements, body: { innerText } })
  vi.stubGlobal('navigator', { userAgent: 'phone-ua' })
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

  it('reports which services exist and what each open preview tab resolves to', () => {
    vi.stubGlobal('location', { origin: 'https://phone.example:18443', pathname: '/' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    stubPage([tab('dsh-resource://file/session/s1/t7.txt', 'loading')], '文件资源服务不可用。')

    reportMobilePageState(context(resourcesWith('live')) as never)

    expect(ingest()[0]?.body).toMatchObject({
      kind: 'mobile-page-state',
      // The whole point: a parked provider chain is visible as a missing service, not as silence.
      services: { resources: true, remote: false, 'remote.workspaceFiles': false },
      probeStatus: 'live',
      absoluteStatus: 'live',
      unavailableVisible: true,
      previews: [{ state: 'loading', address: 'dsh-resource://file/session/s1/t7.txt', status: 'live' }],
    })
  })

  it('reports a preview tab once, and keeps watching until its budget is spent', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('location', { origin: 'https://phone.example:18443', pathname: '/' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const address = 'dsh-resource://file/session/s1/t7.txt'
    let state = 'loading'
    // The stub reads `state` on every call, so the poll sees the tab change under it.
    vi.stubGlobal('document', { querySelectorAll: () => [tab(address, state)], body: { innerText: '' } })
    vi.stubGlobal('navigator', { userAgent: 'phone-ua' })

    const dispose = watchMobilePageState(context(resourcesWith('live')) as never)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(ingest().filter(call => call.body.kind === 'mobile-page-state')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(ingest().filter(call => call.body.kind === 'document-preview-tab')).toHaveLength(1)

    state = 'text'
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ingest().filter(call => call.body.kind === 'document-preview-tab')).toHaveLength(2)
    expect(ingest().filter(call => call.body.kind === 'document-preview-tab')[1]?.body).toMatchObject({ state: 'text' })

    dispose()
    const sent = ingest().length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(ingest()).toHaveLength(sent)
  })

  it('names every loader row that never activated, with the service it waits for', () => {
    const loaderCtx = {
      get: (name: string) => (name === 'loader'
        ? {
            entries: () => [
              { options: { name: 'active-row' }, fiber: { state: 2, inject: {} } },
              { options: { name: '@deepseek-ai/dsh-api-workspace-files' }, fiber: { state: 0, inject: { resources: {}, 'remote.workspaceFiles': {} } } },
            ],
          }
        : name === 'resources' ? resourcesWith('live') : undefined),
    }
    expect(loaderState(loaderCtx as never)).toEqual({
      present: true,
      rows: 2,
      broken: [{ name: '@deepseek-ai/dsh-api-workspace-files', state: 'pending', missing: ['remote.workspaceFiles'] }],
    })
    expect(loaderState({ get: () => undefined } as never)).toEqual({ present: false })
  })

  it('reports how this engine parses the resource address forms', () => {
    const parsed = addressParseState()
    expect(parsed).toHaveLength(3)
    expect(parsed[0]).toBe('dsh-resource:|file')
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
