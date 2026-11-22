import { describe, expect, it } from 'vitest'
import {
  classifyTaskPlatformUpstreamError,
  countClientIdentityHeaders,
  formatTaskPlatformLog,
  isReadOnlyMethod,
  isTaskPlatformPath,
  redactTaskPlatformQuery,
  TASK_PLATFORM_PREFIX,
  taskPlatformUpstreamHeaders,
  taskPlatformUpstreamPath,
} from '../src/task-platform.js'

describe('工单平台只读代注入（纯函数）', () => {
  it('前缀判定只认 /api/task-platform 与它的子路径', () => {
    for (const path of [TASK_PLATFORM_PREFIX, `${TASK_PLATFORM_PREFIX}/api/v1/projects`, `${TASK_PLATFORM_PREFIX}/`]) {
      expect(isTaskPlatformPath(path), path).toBe(true)
    }
    for (const path of ['/api/task-platforms', '/api/task-platformx/a', '/api/mobile-logs', '/apitasks']) {
      expect(isTaskPlatformPath(path), path).toBe(false)
    }
  })

  it('只读方法只有 GET / HEAD（大小写敏感：HTTP 方法本就大写）', () => {
    expect(isReadOnlyMethod('GET')).toBe(true)
    expect(isReadOnlyMethod('HEAD')).toBe(true)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'get', undefined]) {
      expect(isReadOnlyMethod(method), String(method)).toBe(false)
    }
  })

  it('前缀剥掉、其余原样，query 透传', () => {
    expect(taskPlatformUpstreamPath(`${TASK_PLATFORM_PREFIX}/api/v1/projects`, '?limit=1'))
      .toBe('/api/v1/projects?limit=1')
    expect(taskPlatformUpstreamPath(`${TASK_PLATFORM_PREFIX}/api/v1/tickets/7/comments`, ''))
      .toBe('/api/v1/tickets/7/comments')
    expect(taskPlatformUpstreamPath(TASK_PLATFORM_PREFIX, '?x=1')).toBe('/api?x=1')
    expect(() => taskPlatformUpstreamPath('/api/mobile-logs', '')).toThrow()
  })

  it('GET / HEAD 注入服务令牌；写方法绝不注入', () => {
    const base = { upstreamHost: '127.0.0.1:30081', serviceToken: 'token-value' }
    for (const method of ['GET', 'HEAD']) {
      const { headers, injected } = taskPlatformUpstreamHeaders({ ...base, method })
      expect(injected, method).toBe(true)
      expect(headers['x-service-token']).toBe('token-value')
      expect(headers.host).toBe('127.0.0.1:30081')
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const { headers, injected } = taskPlatformUpstreamHeaders({ ...base, method })
      expect(injected, method).toBe(false)
      expect(headers['x-service-token']).toBeUndefined()
    }
  })

  it('令牌缺失 / 空白 / 只有换行 = 不注入（平台按匿名拒绝）', () => {
    for (const serviceToken of [undefined, '', '   ', '\n']) {
      const options = serviceToken === undefined
        ? { method: 'GET', upstreamHost: '127.0.0.1:30081' }
        : { method: 'GET', upstreamHost: '127.0.0.1:30081', serviceToken }
      const { headers, injected } = taskPlatformUpstreamHeaders(options)
      expect(injected).toBe(false)
      expect(headers['x-service-token']).toBeUndefined()
    }
  })

  it('客户端自带的平台身份头一律不进上游，上游身份只由网关构造', () => {
    const { headers, injected } = taskPlatformUpstreamHeaders({
      method: 'GET',
      upstreamHost: '127.0.0.1:30081',
      serviceToken: 'token-value',
      clientHeaders: {
        accept: 'application/json',
        'x-service-token': 'forged-service-token',
        'x-dsh-session-id': 'forged-session',
        'x-dsh-actor-type': 'forged-actor',
        authorization: 'Bearer gateway-token',
        cookie: 'dsh_ma_session=gateway-token',
      },
    })
    expect(injected).toBe(true)
    expect(headers['x-service-token']).toBe('token-value')
    expect(headers['x-dsh-session-id']).toBeUndefined()
    expect(headers['x-dsh-actor-type']).toBeUndefined()
    expect(headers.authorization).toBeUndefined()
    expect(headers.cookie).toBeUndefined()
    expect(headers.accept).toBe('application/json')
  })
})

describe('工单平台转发日志（纯函数）', () => {
  it('query 保留，敏感参数只留长度：access_token / api_key / sessionId 都脱敏', () => {
    expect(redactTaskPlatformQuery('?limit=1&access_token=abc123&q=hello'))
      .toBe('?limit=1&access_token=<redacted:6>&q=hello')
    expect(redactTaskPlatformQuery('?api_key=abcdef&keyword=secret&sort=author'))
      .toBe('?api_key=<redacted:6>&keyword=secret&sort=author')
    expect(redactTaskPlatformQuery('?sessionId=xyz&signature=deadbeef'))
      .toBe('?sessionId=<redacted:3>&signature=<redacted:8>')
  })

  it('没有 query 或没有「=」的裸参数原样保留', () => {
    expect(redactTaskPlatformQuery('')).toBe('')
    expect(redactTaskPlatformQuery('?flag&limit=1')).toBe('?flag&limit=1')
  })

  it('客户端平台身份头数量按实际出现个数计', () => {
    expect(countClientIdentityHeaders(undefined)).toBe(0)
    expect(countClientIdentityHeaders({})).toBe(0)
    expect(countClientIdentityHeaders({
      'x-service-token': 'forged',
      'x-dsh-session-id': 'forged',
      'x-dsh-actor-type': 'forged',
      accept: 'application/json',
    })).toBe(3)
    expect(countClientIdentityHeaders({ 'x-service-token': 'forged' })).toBe(1)
  })

  it('日志单行包含全部必填字段；未拿到上游响应时 upstream_status=none', () => {
    const line = formatTaskPlatformLog({
      method: 'GET',
      path: '/api/task-platform/api/v1/projects?limit=1',
      injected: true,
      upstreamStatus: 200,
      durationMs: 12.4,
      clientIdentityHeadersStripped: 2,
      outcome: 'ok',
    })
    expect(line).toBe('[task-platform] method=GET path=/api/task-platform/api/v1/projects?limit=1'
      + ' injected=true upstream_status=200 duration_ms=12 client_identity_headers_stripped=2 outcome=ok')

    const unavailable = formatTaskPlatformLog({
      method: 'GET',
      path: '/api/task-platform/api/v1/projects',
      injected: true,
      upstreamError: 'ECONNREFUSED',
      durationMs: 3,
      clientIdentityHeadersStripped: 0,
      outcome: 'upstream_unreachable',
    })
    expect(unavailable).toContain('upstream_status=none')
    expect(unavailable).toContain('upstream_error=ECONNREFUSED')
    expect(unavailable).toContain('outcome=upstream_unreachable')

    const unauthorized = formatTaskPlatformLog({
      method: 'GET',
      path: '/api/task-platform/api/v1/projects',
      injected: false,
      upstreamError: 'not_forwarded',
      durationMs: 0,
      clientIdentityHeadersStripped: 0,
      outcome: 'unauthorized',
    })
    expect(unauthorized).toContain('upstream_status=none')
    expect(unauthorized).toContain('outcome=unauthorized')
  })

  it('上游失败原因只取错误码 / timeout，不回显可能带地址的 message', () => {
    expect(classifyTaskPlatformUpstreamError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:30081'), { code: 'ECONNREFUSED' })))
      .toBe('ECONNREFUSED')
    expect(classifyTaskPlatformUpstreamError(new Error('task_platform_timeout'))).toBe('timeout')
    expect(classifyTaskPlatformUpstreamError(new Error('boom at 10.0.0.1:99'))).toBe('request_failed')
    expect(classifyTaskPlatformUpstreamError(undefined)).toBe('request_failed')
  })
})
