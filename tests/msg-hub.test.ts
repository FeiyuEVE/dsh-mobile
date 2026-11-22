import { describe, expect, it } from 'vitest'
import {
  classifyMsgHubUpstreamError,
  countMsgHubIdentityHeaders,
  filterScheduleQuery,
  formatMsgHubLog,
  isMsgHubPath,
  matchMsgHubRoute,
  MSG_HUB_PREFIX,
  msgHubUpstreamHeaders,
  msgHubUpstreamPath,
  redactMsgHubQuery,
} from '../src/msg-hub.js'

describe('msg-hub 代理白名单（纯函数）', () => {
  it('前缀判定只认 /api/msg-hub 与它的子路径', () => {
    for (const path of [MSG_HUB_PREFIX, `${MSG_HUB_PREFIX}/v1/schedules`, `${MSG_HUB_PREFIX}/`]) {
      expect(isMsgHubPath(path), path).toBe(true)
    }
    for (const path of ['/api/msg-hubx', '/api/msg-hubx/a', '/api/task-platform/api/v1/projects', '/api/mobile-logs']) {
      expect(isMsgHubPath(path), path).toBe(false)
    }
  })

  it('列表：只有 GET / HEAD 放行', () => {
    expect(matchMsgHubRoute(`${MSG_HUB_PREFIX}/v1/schedules`, 'GET')).toEqual({ ok: true, route: { kind: 'list' } })
    expect(matchMsgHubRoute(`${MSG_HUB_PREFIX}/v1/schedules`, 'HEAD')).toEqual({ ok: true, route: { kind: 'list' } })
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'get', undefined]) {
      expect(matchMsgHubRoute(`${MSG_HUB_PREFIX}/v1/schedules`, method), String(method)).toEqual({
        ok: false,
        error: 'method_not_allowed',
      })
    }
  })

  it('取消：只有 POST /v1/schedules/{id}/cancel 放行，id 必须是正整数', () => {
    expect(matchMsgHubRoute(`${MSG_HUB_PREFIX}/v1/schedules/7/cancel`, 'POST')).toEqual({
      ok: true,
      route: { kind: 'cancel', id: 7 },
    })
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', undefined]) {
      expect(matchMsgHubRoute(`${MSG_HUB_PREFIX}/v1/schedules/7/cancel`, method), String(method)).toEqual({
        ok: false,
        error: 'method_not_allowed',
      })
    }
    for (const path of [
      `${MSG_HUB_PREFIX}/v1/schedules/0/cancel`,
      `${MSG_HUB_PREFIX}/v1/schedules/-1/cancel`,
      `${MSG_HUB_PREFIX}/v1/schedules/abc/cancel`,
      `${MSG_HUB_PREFIX}/v1/schedules/7/cancel/`,
      `${MSG_HUB_PREFIX}/v1/schedules/7`,
    ]) {
      expect(matchMsgHubRoute(path, 'POST'), path).toEqual({ ok: false, error: 'route_denied' })
    }
  })

  it('白名单外的路径（含新建 / 广播 / 启停）一律 route_denied', () => {
    for (const path of [
      MSG_HUB_PREFIX,
      `${MSG_HUB_PREFIX}/`,
      `${MSG_HUB_PREFIX}/v1/broadcasts`,
      `${MSG_HUB_PREFIX}/v1/schedules/`,
      `${MSG_HUB_PREFIX}/v1/schedules/7/disable`,
    ]) {
      expect(matchMsgHubRoute(path, 'POST'), path).toEqual({ ok: false, error: 'route_denied' })
    }
    expect(matchMsgHubRoute('/api/task-platform/api/v1/projects', 'GET')).toEqual({
      ok: false,
      error: 'route_denied',
    })
  })

  it('上游路径：列表带过滤后的 query，取消不带 query', () => {
    expect(msgHubUpstreamPath({ kind: 'list' })).toBe('/v1/schedules')
    expect(msgHubUpstreamPath({ kind: 'list' }, '?limit=5')).toBe('/v1/schedules?limit=5')
    expect(msgHubUpstreamPath({ kind: 'cancel', id: 42 })).toBe('/v1/schedules/42/cancel')
  })

  it('query 过滤：只留 enabled / creator / limit / cursor，原编码不动', () => {
    expect(filterScheduleQuery('')).toBe('')
    expect(filterScheduleQuery('?limit=5&enabled=true&creator=session%3Aabc&evil=1')).toBe(
      '?limit=5&enabled=true&creator=session%3Aabc',
    )
    expect(filterScheduleQuery('?cursor=1f&cursor=20')).toBe('?cursor=1f&cursor=20')
    // 未知键一律丢；超长值也丢。
    expect(filterScheduleQuery('?q=x')).toBe('')
    expect(filterScheduleQuery(`?limit=${'9'.repeat(300)}`)).toBe('')
    // 非法百分号编码：丢掉该键，不影响其它键。
    expect(filterScheduleQuery('?limit=5&creator=%E0%A4%A')).toBe('?limit=5')
  })

  it('上游头：注入 hub 令牌；客户端身份头与 authorization / cookie 都不转发', () => {
    const { headers, injected } = msgHubUpstreamHeaders({
      upstreamHost: '127.0.0.1:8787',
      serviceToken: 'hub-token',
      clientHeaders: {
        accept: 'application/json',
        'accept-language': 'zh-CN',
        'user-agent': 'dsh-mobile',
        authorization: 'Bearer app-token',
        cookie: 'dsh_ma_session=abc',
        'x-service-token': 'forged',
        'x-dsh-session-id': 'forged-session',
        'x-codex-thread-id': 'forged-thread',
        'x-dsh-actor-type': 'forged-actor',
      },
    })
    expect(injected).toBe(true)
    expect(headers.host).toBe('127.0.0.1:8787')
    expect(headers['x-service-token']).toBe('hub-token')
    for (const name of ['authorization', 'cookie', 'x-dsh-session-id', 'x-codex-thread-id', 'x-dsh-actor-type']) {
      expect(headers[name], name).toBeUndefined()
    }
    expect(headers.accept).toBe('application/json')
  })

  it('令牌缺失 / 空白 / 只有换行 = 不注入（hub 自己回 401）', () => {
    for (const serviceToken of [undefined, '', '   ', '\n']) {
      const options = serviceToken === undefined
        ? { upstreamHost: '127.0.0.1:8787' }
        : { upstreamHost: '127.0.0.1:8787', serviceToken }
      const { headers, injected } = msgHubUpstreamHeaders(options)
      expect(injected, String(serviceToken)).toBe(false)
      expect(headers['x-service-token']).toBeUndefined()
    }
  })

  it('客户端身份头计数：证明伪造头确实被剔除', () => {
    expect(countMsgHubIdentityHeaders(undefined)).toBe(0)
    expect(countMsgHubIdentityHeaders({})).toBe(0)
    expect(countMsgHubIdentityHeaders({
      'x-service-token': 'a',
      'x-dsh-session-id': 'b',
      'x-codex-thread-id': 'c',
      'x-dsh-actor-type': 'd',
    })).toBe(4)
  })

  it('日志 query：只留白名单键，creator 脱敏', () => {
    expect(redactMsgHubQuery('')).toBe('')
    expect(redactMsgHubQuery('?limit=5&creator=session%3Asecret-session')).toBe(
      '?limit=5&creator=<redacted:22>',
    )
    expect(redactMsgHubQuery('?evil=1')).toBe('')
  })

  it('上游失败类别只取错误码 / timeout，不回显 message', () => {
    expect(classifyMsgHubUpstreamError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), { code: 'ECONNREFUSED' })))
      .toBe('ECONNREFUSED')
    expect(classifyMsgHubUpstreamError(new Error('msg_hub_timeout'))).toBe('timeout')
    expect(classifyMsgHubUpstreamError(new Error('boom 127.0.0.1:8787'))).toBe('request_failed')
    expect(classifyMsgHubUpstreamError('string')).toBe('request_failed')
  })

  it('结构化日志：单行、字段顺序固定、令牌不出现', () => {
    const line = formatMsgHubLog({
      method: 'POST',
      path: '/api/msg-hub/v1/schedules/7/cancel',
      injected: true,
      upstreamStatus: 200,
      durationMs: 12.4,
      clientIdentityHeadersStripped: 0,
      outcome: 'ok',
    })
    expect(line).toBe(
      '[msg-hub] method=POST path=/api/msg-hub/v1/schedules/7/cancel injected=true '
      + 'upstream_status=200 duration_ms=12 client_identity_headers_stripped=0 outcome=ok',
    )
    const none = formatMsgHubLog({
      method: 'GET',
      path: '/api/msg-hub/v1/schedules',
      injected: false,
      upstreamError: 'ECONNREFUSED',
      durationMs: 3,
      clientIdentityHeadersStripped: 2,
      outcome: 'upstream_unreachable',
    })
    expect(none).toContain('upstream_status=none upstream_error=ECONNREFUSED')
    expect(none).not.toContain('\n')
  })
})
