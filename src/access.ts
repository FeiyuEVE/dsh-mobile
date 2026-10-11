/**
 * 会话原语：**配对/设备模式已整体删除**，这个文件只剩三样被账号链路复用的东西。
 *
 * - [AccessError]：稳定错误分类（`mapError` 折成简短 HTTP 响应）；
 * - [SessionAuthorization]：一次授权请求的身份（sessionKey / 过期时刻），
 *   账号 token 也用它承载（见 `account.ts` 的 `tokenSessionKey`）；
 * - [BoundedRateLimiter]：有界限流表（登录尝试用；满表 fail closed）。
 *
 * 曾经的 `AccessController`（配对窗口、设备令牌、短会话续期、`devices.json`）
 * 连同 `storage.ts` 一起删掉了：凭据只有一个来源——账号密码换来的一枚 token。
 */

/** Stable error categories converted to deliberately terse HTTP responses. */
export class AccessError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
    this.name = 'AccessError'
  }
}

export interface SessionAuthorization {
  readonly sessionKey: string
  readonly deviceId: string
  readonly expiresAt: number
}

interface LimitBucket {
  count: number
  resetAt: number
}

/** Bounded fixed-window rate limiter shared by the login path. */
export class BoundedRateLimiter {
  private readonly buckets = new Map<string, LimitBucket>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maximumKeys: number,
  ) {}

  /** Consume one attempt; unknown keys fail closed when the bounded table is full. */
  take(key: string, now: number): boolean {
    for (const [candidate, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(candidate)
    }
    const current = this.buckets.get(key)
    if (current === undefined) {
      if (this.buckets.size >= this.maximumKeys) return false
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    if (current.count >= this.limit) return false
    current.count += 1
    return true
  }

  /** Current table size, exposed for bounded-state assertions. */
  get size(): number {
    return this.buckets.size
  }
}
