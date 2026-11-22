import { describe, expect, it } from 'vitest'
import {
  isReadOnlyMethod,
  isTaskPlatformPath,
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
