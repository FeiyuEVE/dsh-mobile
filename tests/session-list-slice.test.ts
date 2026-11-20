import { describe, expect, it } from 'vitest'
import {
  buildSessionListResponse,
  compareSessionListEntries,
  decodeSessionListCursor,
  encodeSessionListCursor,
  locateSessionListDocument,
  planSessionListRequest,
  readSessionListEntries,
  SessionListCache,
  SESSION_LIST_ERROR_MESSAGES,
  sliceSessionListItems,
  type SessionListCursor,
} from '../src/session-list-slice.js'

interface Item {
  readonly sessionId: string
  readonly updatedAt: number
  readonly [key: string]: unknown
}

function item(sessionId: string, updatedAt: number, extra: Record<string, unknown> = {}): Item {
  return { sessionId, updatedAt, running: false, blank: false, cwd: '/workspace/example', ...extra }
}

function body(args: Record<string, unknown> | undefined): Buffer {
  return Buffer.from(JSON.stringify({
    type: 'client-request',
    rpcId: 'rpc-1',
    method: 'session/list',
    payload: args === undefined ? {} : { args },
  }))
}

function envelope(items: unknown[]): Record<string, unknown> {
  return { type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value: { items } } }
}

/** 按 `updatedAt desc, sessionId asc` 排好的固定 fixture（含同时间戳并列）。 */
const FIXTURE: Item[] = [
  item('s-a', 300, { lastMessage: 'a' }),
  item('s-e', 300, { lastMessage: 'e' }),
  item('s-b', 200, { lastMessage: 'b' }),
  item('s-c', 200, { lastMessage: 'c' }),
  item('s-d', 100, { lastMessage: 'd' }),
]

describe('planSessionListRequest', () => {
  it('透传：没有 _request、没有 limit、请求体不是 JSON 都不切片', () => {
    expect(planSessionListRequest(Buffer.from('not json'), 20)).toEqual({ kind: 'passthrough' })
    expect(planSessionListRequest(body(undefined), 20)).toEqual({ kind: 'passthrough' })
    expect(planSessionListRequest(body({}), 20)).toEqual({ kind: 'passthrough' })
    expect(planSessionListRequest(body({ _request: {} }), 20)).toEqual({ kind: 'passthrough' })
    expect(planSessionListRequest(body({ _request: { cursor: 'abc' } }), 20)).toEqual({ kind: 'passthrough' })
  })

  it('接受 1..maximum 的整数 limit，并解码可选 cursor', () => {
    expect(planSessionListRequest(body({ _request: { limit: 1 } }), 20)).toEqual({ kind: 'page', limit: 1, rpcId: 'rpc-1' })
    expect(planSessionListRequest(body({ _request: { limit: 20 } }), 20)).toEqual({ kind: 'page', limit: 20, rpcId: 'rpc-1' })
    const cursor = encodeSessionListCursor({ updatedAt: 200, sessionId: 's-b' })
    expect(planSessionListRequest(body({ _request: { limit: 5, cursor } }), 100)).toEqual({
      kind: 'page',
      limit: 5,
      cursor: { updatedAt: 200, sessionId: 's-b' },
      rpcId: 'rpc-1',
    })
  })

  it('limit 非整数 / 0 / 超过配置上限 / 字符串 / null 一律 400 invalid_limit', () => {
    for (const limit of [0, 21, 101, -1, 1.5, '20', 'abc', true, null]) {
      const plan = planSessionListRequest(body({ _request: { limit } }), 20)
      expect(plan).toEqual({
        kind: 'invalid',
        error: 'invalid_limit',
        message: SESSION_LIST_ERROR_MESSAGES.invalid_limit(20),
      })
    }
    // 配置上限拉到 100 时，51..100 才是合法值
    expect(planSessionListRequest(body({ _request: { limit: 100 } }), 100)).toEqual({ kind: 'page', limit: 100, rpcId: 'rpc-1' })
    expect(planSessionListRequest(body({ _request: { limit: 101 } }), 100)).toMatchObject({
      kind: 'invalid',
      error: 'invalid_limit',
    })
  })

  it('cursor 非字符串 / 乱码 / 非法字段一律 400 invalid_cursor', () => {
    for (const cursor of ['乱码', 'abc=', 'Zm9v', 'WzEsMl0', 42, null]) {
      expect(planSessionListRequest(body({ _request: { limit: 10, cursor } }), 20)).toEqual({
        kind: 'invalid',
        error: 'invalid_cursor',
        message: SESSION_LIST_ERROR_MESSAGES.invalid_cursor,
      })
    }
  })
})

describe('session list cursor', () => {
  it('base64url(JSON([updatedAt, sessionId])) 往返一致', () => {
    const cursor = { updatedAt: 1_700_000_000_000, sessionId: 'session-abc' }
    const encoded = encodeSessionListCursor(cursor)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u)
    expect(decodeSessionListCursor(encoded)).toEqual(cursor)
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).toBe(JSON.stringify([cursor.updatedAt, cursor.sessionId]))
  })

  it('拒绝非规范编码（重新编码不等价）、负时间戳与空 id', () => {
    const nonCanonical = Buffer.from('[200, "s-b"]', 'utf8').toString('base64url')
    expect(() => decodeSessionListCursor(nonCanonical)).toThrow(/canonical/u)
    expect(() => decodeSessionListCursor(Buffer.from(JSON.stringify([-1, 's']), 'utf8').toString('base64url'))).toThrow(/updatedAt/u)
    expect(() => decodeSessionListCursor(Buffer.from(JSON.stringify([1, '']), 'utf8').toString('base64url'))).toThrow(/sessionId/u)
    expect(() => decodeSessionListCursor(Buffer.from(JSON.stringify([1, 2]), 'utf8').toString('base64url'))).toThrow(/sessionId/u)
    expect(() => decodeSessionListCursor(Buffer.from(JSON.stringify([1, 's', 3]), 'utf8').toString('base64url'))).toThrow(/two-element/u)
  })
})

describe('sliceSessionListItems', () => {
  it('排序键是 updatedAt desc + sessionId asc，且条目引用原样保留', () => {
    const entries = readSessionListEntries(FIXTURE)!
    const sliced = sliceSessionListItems(FIXTURE, entries, 5, undefined)
    expect(sliced.items.map(value => (value as Item).sessionId)).toEqual(['s-a', 's-e', 's-b', 's-c', 's-d'])
    expect(sliced.nextCursor).toBeUndefined()
    // 同一引用：不重建对象、不丢字段
    expect(sliced.items[0]).toBe(FIXTURE[0])
    expect(sliced.items[0]).toEqual({ ...FIXTURE[0] })
  })

  it('逐页拼接正好等于全量排序序列，页间 id 交集为 0，末页无 nextCursor', () => {
    const entries = readSessionListEntries(FIXTURE)!
    const all: string[] = []
    let cursor: SessionListCursor | undefined
    const pages: string[][] = []
    for (let guard = 0; guard < 10; guard += 1) {
      const sliced = sliceSessionListItems(FIXTURE, entries, 2, cursor)
      pages.push(sliced.items.map(value => (value as Item).sessionId))
      all.push(...pages.at(-1)!)
      if (sliced.nextCursor === undefined) break
      cursor = decodeSessionListCursor(sliced.nextCursor)
    }
    expect(pages).toEqual([['s-a', 's-e'], ['s-b', 's-c'], ['s-d']])
    expect(all).toEqual(['s-a', 's-e', 's-b', 's-c', 's-d'])
    for (let index = 1; index < pages.length; index += 1) {
      expect(pages[index]!.filter(id => pages[index - 1]!.includes(id))).toEqual([])
    }
  })

  it('空列表 / 游标落在末尾都回空页且无 nextCursor', () => {
    expect(sliceSessionListItems([], [], 10, undefined)).toEqual({ items: [] })
    const sliced = sliceSessionListItems(FIXTURE, readSessionListEntries(FIXTURE)!, 10, { updatedAt: 100, sessionId: 's-d' })
    expect(sliced).toEqual({ items: [] })
  })

  it('任一 entry 缺 sessionId / updatedAt 就整体放弃（由调用方透传）', () => {
    expect(readSessionListEntries([item('ok', 1), { updatedAt: 2 }])).toBeUndefined()
    expect(readSessionListEntries([item('ok', 1), { sessionId: 'x' }])).toBeUndefined()
    expect(readSessionListEntries([item('ok', 1), { sessionId: 'x', updatedAt: 1.5 }])).toBeUndefined()
    expect(readSessionListEntries([item('ok', 1), { sessionId: '', updatedAt: 1 }])).toBeUndefined()
  })

  it('比较函数按 UTF-8 字节比较 id，不受 locale 影响', () => {
    expect(compareSessionListEntries({ updatedAt: 2, sessionId: 'a' }, { updatedAt: 1, sessionId: 'z' })).toBeLessThan(0)
    expect(compareSessionListEntries({ updatedAt: 1, sessionId: 'B' }, { updatedAt: 1, sessionId: 'a' })).toBeLessThan(0)
  })
})

describe('session list document', () => {
  it('定位 RPC 信封里的 result.value.items 与裸 {items}', () => {
    const rpc = locateSessionListDocument(envelope(FIXTURE))!
    expect(rpc.items).toBe((rpc.holder as { items: unknown[] }).items)
    expect((rpc.root.result as { ok: boolean }).ok).toBe(true)
    const bare = locateSessionListDocument({ items: FIXTURE })!
    expect(bare.holder).toBe(bare.root)
    expect(locateSessionListDocument({ result: { ok: false } })).toBeUndefined()
    expect(locateSessionListDocument(null)).toBeUndefined()
  })

  it('写回时保留其它字段，只在有下一页时追加 nextCursor', () => {
    const document = locateSessionListDocument(envelope(FIXTURE))!
    const body = buildSessionListResponse(document, [FIXTURE[0]!], 'cursor-next')
    const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>
    expect(parsed).toMatchObject({ type: 'server-response', rpcId: 'rpc-1', result: { ok: true } })
    expect((parsed.result as { value: Record<string, unknown> }).value).toEqual({
      items: [FIXTURE[0]],
      nextCursor: 'cursor-next',
    })

    // 缓存命中时信封里的 rpcId 必须换成当前请求的
    const requester = buildSessionListResponse(document, [FIXTURE[0]!], undefined, 'rpc-current')
    expect(JSON.parse(requester.toString('utf8')).rpcId).toBe('rpc-current')

    const lastPage = buildSessionListResponse(document, [FIXTURE[0]!], undefined)
    const lastParsed = JSON.parse(lastPage.toString('utf8')) as { result: { value: Record<string, unknown> } }
    expect(lastParsed.result.value).toEqual({ items: [FIXTURE[0]] })
    expect(lastParsed.result.value).not.toHaveProperty('nextCursor')
  })
})

describe('SessionListCache', () => {
  const key = 'session-key-a'
  const bytes = Buffer.from('{"items":[]}')

  it('命中、按授权身份隔离、过期后失效', () => {
    const cache = new SessionListCache(1_000)
    cache.set(key, bytes, 10_000)
    expect(cache.get(key, 10_500)).toBe(bytes)
    expect(cache.get('another-session', 10_500)).toBeUndefined()
    // 身份不符会清掉唯一一条
    expect(cache.get(key, 12_000)).toBeUndefined()
  })

  it('ttl=0 关闭缓存；超过上限的体不缓存', () => {
    const disabled = new SessionListCache(0)
    disabled.set(key, bytes, 0)
    expect(disabled.get(key, 0)).toBeUndefined()

    const bounded = new SessionListCache(1_000, 4)
    bounded.set(key, bytes, 0)
    expect(bounded.get(key, 1)).toBeUndefined()
    bounded.set(key, Buffer.from('abc'), 0)
    expect(bounded.get(key, 1)?.toString()).toBe('abc')
  })

  it('重复写入会覆盖上一条（单条缓存）', () => {
    const cache = new SessionListCache(1_000)
    cache.set(key, Buffer.from('first'), 0)
    cache.set(key, Buffer.from('second'), 0)
    expect(cache.get(key, 1)?.toString()).toBe('second')
  })
})
