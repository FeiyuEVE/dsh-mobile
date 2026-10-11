import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { AccessError, BoundedRateLimiter, type SessionAuthorization } from './access.js'
import { restrictPrivateFile } from './private-file.js'

/**
 * Single-account credential authority with one-month bearer tokens.
 *
 * 这一块是「配对模式」的替代品：手机用账号密码换一枚 30 天 token，同一枚 token
 * 在局域网 / IPv6 / 公网三条线路上都成立（网关把三条线路收进同一个认证面），
 * 原生 API 走 `Authorization: Bearer`，WebView 走同名 cookie。三条硬约束：
 *
 * 1. **只落摘要**：token 与 csrf 都只存 sha256，明文只在签发那一刻回给客户端；
 *    账号密码只存 scrypt 派生值 + 随机 salt，明文永不落盘、不进日志。
 * 2. **token 必须落盘**：老 Session 是内存 Map（重启即掉），一个月有效期若沿用
 *    内存就等于从未兑现——token 表落 `tokens.json`，重启后照旧有效。
 * 3. **授权对象的 expiresAt 必须钳住**：网关 `allocateRequest` 用
 *    `setTimeout(expiresAt - now)`，超过 2^31-1 ms（约 24.8 天）会被 Node 截断成
 *    1 ms，长连接与请求会被立刻 abort。所以对外授权一律钳到
 *    {@link AUTHORIZATION_HORIZON_MS} 以内，token 本身的到期时间另行保留。
 */

/** Authorization horizon handed to the gateway, safely below the 2^31-1 ms timer bound. */
export const AUTHORIZATION_HORIZON_MS = 20 * 24 * 60 * 60_000

/** Default one-month credential lifetime requested by the product. */
export const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000

/** scrypt cost used for the account password. 128*N*r must stay below maxmem. */
const SCRYPT_COST = Object.freeze({ N: 32_768, r: 8, p: 1, keylen: 32 })
const SCRYPT_MAXMEM = 96 * 1024 * 1024
const MAX_SECRET_LENGTH = 512
const MAX_USERNAME_LENGTH = 64
const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 256

const derive = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

/** Durable single-account record; the plaintext password is never a member. */
export interface AccountRecord {
  readonly username: string
  readonly salt: string
  readonly hash: string
  readonly cost: { readonly N: number; readonly r: number; readonly p: number; readonly keylen: number }
  readonly createdAt: number
  readonly updatedAt: number
}

/** Versioned account state. */
export interface AccountSnapshot {
  readonly version: 1
  readonly account?: AccountRecord
}

/** Durable long-lived token record; only digests survive issuance. */
export interface TokenRecord {
  readonly id: string
  readonly label: string
  readonly tokenDigest: string
  readonly csrfDigest: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly lastSeenAt: number
  readonly revokedAt?: number
}

/** Versioned token table. */
export interface TokenSnapshot {
  readonly version: 1
  readonly tokens: readonly TokenRecord[]
}

/** Persistence seams so embedding and tests can substitute memory stores. */
export interface AccountStore {
  load(): Promise<AccountSnapshot>
  save(snapshot: AccountSnapshot): Promise<void>
  /**
   * **同步**指纹：文件内容变了就与上一次不同（实现用 mtime+size，够便宜）。
   *
   * 存在它的理由是「多进程共用一个账号目录」：web / staging 两个 dsh 进程各有一份
   * 内存快照，必须能发现**别的进程刚写的**账号/令牌（见 `AccountController.refreshSync`）。
   * 不实现（内存 store / 老实现）＝退回单进程语义，不影响正确性。
   */
  revision?(): string | undefined
  /** **同步**读一次快照，供授权热路径使用（只在 [revision] 变了时才调用）。 */
  loadSync?(): AccountSnapshot
}

export interface TokenStore {
  load(): Promise<TokenSnapshot>
  save(snapshot: TokenSnapshot): Promise<void>
  /** 见 [AccountStore.revision]。 */
  revision?(): string | undefined
  /** 见 [AccountStore.loadSync]。 */
  loadSync?(): TokenSnapshot
}

/** One issued credential pair plus the metadata the client may display. */
export interface AccountLoginResult {
  readonly tokenId: string
  readonly token: string
  readonly csrfToken: string
  readonly expiresAt: number
  readonly username: string
  readonly label: string
}

/** Safe token metadata for the sign-in device list. */
export interface AccountTokenSummary {
  readonly id: string
  readonly label: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly lastSeenAt: number
  readonly revokedAt?: number
}

export interface AccountControllerOptions {
  readonly tokenTtlMs: number
  readonly maxTokens: number
  readonly rateLimitWindowMs: number
  readonly maxLoginAttempts: number
  readonly maxRateLimitKeys: number
  readonly now?: () => number
  /**
   * 跨进程读改写锁的路径（多进程共用同一账号目录时必给）。
   *
   * 不给＝单进程语义（内存 store / 老部署照旧）；给了但拿不到锁会抛 503 `state_busy`。
   */
  readonly lockPath?: string
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function sha256Hex(value: string): string {
  return sha256(value).toString('hex')
}

function opaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

function timingSafeText(left: string, right: string): boolean {
  return timingSafeEqual(sha256(left), sha256(right))
}

function normalizeUsername(value: string): string {
  const username = value.normalize('NFC').trim()
  if (username.length < 1 || username.length > MAX_USERNAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(username)) {
    throw new AccessError(400, 'invalid_request')
  }
  return username
}

function normalizeLabel(value: string | undefined): string {
  const label = (value ?? 'Mobile device').normalize('NFC').trim()
  if (label.length < 1 || label.length > 64 || /[\u0000-\u001f\u007f]/u.test(label)) {
    throw new AccessError(400, 'invalid_request')
  }
  return label
}

function assertNonNegativeInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`account state ${name} must be a non-negative integer`)
  }
}

function assertDigest(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/u.test(value)) {
    throw new Error(`account state contains an invalid ${name}`)
  }
}

function parseAccount(value: unknown): AccountRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('account state contains an invalid account')
  const record = value as Record<string, unknown>
  if (typeof record.username !== 'string' || record.username.length < 1 || record.username.length > MAX_USERNAME_LENGTH) {
    throw new Error('account state contains an invalid username')
  }
  if (typeof record.salt !== 'string' || !/^[A-Za-z\d+/]{16,64}={0,2}$/u.test(record.salt)) {
    throw new Error('account state contains an invalid salt')
  }
  assertDigest(record.hash, 'password hash')
  const cost = record.cost
  if (typeof cost !== 'object' || cost === null || Array.isArray(cost)) throw new Error('account state contains an invalid cost')
  const { N, r, p, keylen } = cost as Record<string, unknown>
  if (typeof N !== 'number' || typeof r !== 'number' || typeof p !== 'number' || typeof keylen !== 'number'
    || !Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p) || !Number.isSafeInteger(keylen)
    || N < 1024 || N > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16 || keylen < 16 || keylen > 128) {
    throw new Error('account state contains an unsupported scrypt cost')
  }
  assertNonNegativeInteger(record.createdAt, 'createdAt')
  assertNonNegativeInteger(record.updatedAt, 'updatedAt')
  return Object.freeze({
    username: record.username,
    salt: record.salt,
    hash: record.hash,
    cost: Object.freeze({ N, r, p, keylen }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  })
}

/** Validate durable account state before it can authorize a login. */
export function parseAccountSnapshot(value: unknown): AccountSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('account state must be an object')
  const snapshot = value as Record<string, unknown>
  if (snapshot.version !== 1) throw new Error('account state has an unsupported version')
  if (snapshot.account === undefined) return Object.freeze({ version: 1 })
  return Object.freeze({ version: 1, account: parseAccount(snapshot.account) })
}

function parseToken(value: unknown): TokenRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('token state contains an invalid token')
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !/^[a-f\d]{32}$/u.test(record.id)) throw new Error('token state contains an invalid id')
  if (typeof record.label !== 'string' || record.label.length < 1 || record.label.length > 64 || /[\u0000-\u001f\u007f]/u.test(record.label)) {
    throw new Error('token state contains an invalid label')
  }
  assertDigest(record.tokenDigest, 'credential digest')
  assertDigest(record.csrfDigest, 'csrf digest')
  assertNonNegativeInteger(record.createdAt, 'createdAt')
  assertNonNegativeInteger(record.expiresAt, 'expiresAt')
  assertNonNegativeInteger(record.lastSeenAt, 'lastSeenAt')
  if (record.revokedAt !== undefined) assertNonNegativeInteger(record.revokedAt, 'revokedAt')
  if (record.expiresAt <= record.createdAt || record.lastSeenAt < record.createdAt) {
    throw new Error('token state contains inconsistent timestamps')
  }
  return Object.freeze({
    id: record.id,
    label: record.label,
    tokenDigest: record.tokenDigest,
    csrfDigest: record.csrfDigest,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastSeenAt: record.lastSeenAt,
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  })
}

/**
 * 已撤销的 token 记录保留多久（只为了「已登录设备」列表能看见刚踢掉的那台）。
 * 过期不是安全边界——撤销判定看 `revokedAt`，保留只是展示。
 */
const REVOKED_RETENTION_MS = 7 * 24 * 60 * 60_000

/** 已撤销记录额外占的容量余量（快照上限 = 活跃上限 + 这个数）。 */
const REVOKED_RETENTION_SLACK = 64

/**
 * token 快照（`tokens.json`）允许的总条数。
 *
 * **`maxTokens` 是「活跃 token 上限」，不是文件长度上限**：撤销记录还要留
 * [REVOKED_RETENTION_MS] 供设备列表展示，所以文件容量必须比活跃上限宽一截，
 * 否则「活跃打满 + 踢掉一台 + 再登录」会写出超长快照、下次解析直接抛错
 * （登录从此 500，直到撤销记录满 7 天被清理为止）。
 */
export function tokenSnapshotLimit(maxTokens: number): number {
  return maxTokens + REVOKED_RETENTION_SLACK
}

/** Validate durable token state before it can authorize a request. */
export function parseTokenSnapshot(value: unknown, maximumTokens = 256): TokenSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('token state must be an object')
  const snapshot = value as Record<string, unknown>
  if (snapshot.version !== 1 || !Array.isArray(snapshot.tokens) || snapshot.tokens.length > maximumTokens) {
    throw new Error('token state has an unsupported version or token count')
  }
  const tokens = snapshot.tokens.map(parseToken)
  if (new Set(tokens.map(token => token.id)).size !== tokens.length
    || new Set(tokens.map(token => token.tokenDigest)).size !== tokens.length) {
    throw new Error('token state contains duplicate token identities')
  }
  return Object.freeze({ version: 1, tokens: Object.freeze(tokens) })
}

async function readStateFile(file: string): Promise<unknown> {
  let stat
  try {
    stat = await lstat(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error('account state must be a regular file no larger than 1 MiB')
  }
  await restrictPrivateFile(file)
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch (error) {
    throw new Error('account state is not valid JSON', { cause: error })
  }
}

async function writeStateFile(file: string, validated: unknown): Promise<void> {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    const current = await lstat(file)
    if (!current.isFile() || current.isSymbolicLink()) throw new Error('account state target must remain a regular file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = join(directory, `.${basename(file)}.${randomBytes(12).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(validated)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
    await restrictPrivateFile(file)
  } catch (error) {
    try {
      await rm(temporary, { force: true })
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'account state write and temporary cleanup both failed')
    }
    throw error
  }
}

/** Atomic JSON account store with symlink refusal and owner-only file creation. */
export class JsonAccountStore implements AccountStore {
  constructor(private readonly file: string) {}

  async load(): Promise<AccountSnapshot> {
    const parsed = await readStateFile(this.file)
    if (parsed === undefined) return Object.freeze({ version: 1 })
    return parseAccountSnapshot(parsed)
  }

  async save(snapshot: AccountSnapshot): Promise<void> {
    await writeStateFile(this.file, parseAccountSnapshot(snapshot))
  }

  revision(): string | undefined {
    return stateFingerprint(this.file)
  }

  loadSync(): AccountSnapshot {
    const parsed = readStateFileSync(this.file)
    if (parsed === undefined) return Object.freeze({ version: 1 })
    return parseAccountSnapshot(parsed)
  }
}

/** Atomic JSON token store with symlink refusal and owner-only file creation. */
export class JsonTokenStore implements TokenStore {
  constructor(private readonly file: string, private readonly maximumTokens = 256) {}

  async load(): Promise<TokenSnapshot> {
    const parsed = await readStateFile(this.file)
    if (parsed === undefined) return Object.freeze({ version: 1, tokens: Object.freeze([]) })
    return parseTokenSnapshot(parsed, this.maximumTokens)
  }

  async save(snapshot: TokenSnapshot): Promise<void> {
    await writeStateFile(this.file, parseTokenSnapshot(snapshot, this.maximumTokens))
  }

  revision(): string | undefined {
    return stateFingerprint(this.file)
  }

  loadSync(): TokenSnapshot {
    const parsed = readStateFileSync(this.file)
    if (parsed === undefined) return Object.freeze({ version: 1, tokens: Object.freeze([]) })
    return parseTokenSnapshot(parsed, this.maximumTokens)
  }
}

/**
 * 跨进程读改写锁（多进程共用同一账号目录时用）。
 *
 * 为什么要锁：两个 dsh 进程各持一份内存快照，写盘是「整份快照原子替换」——
 * 没有互斥时，A 读改写与 B 读改写交错会丢掉其中一方刚签发的 token（症状就是
 * 「在正式服登录、切到测试服又被登出」）。锁文件用 `wx` 创建即独占；
 * 持有者崩溃留下的陈旧锁按 [STATE_LOCK_STALE_MS] 回收。
 *
 * 拿不到锁**不静默继续**：抛 503 `state_busy`（登录是低频操作，宁可让客户端重试，
 * 也不要写出一份丢 token 的表）。
 */
const STATE_LOCK_STALE_MS = 15_000
const STATE_LOCK_TIMEOUT_MS = 3_000
const STATE_LOCK_RETRY_MS = 40

async function withStateLock<T>(lockPath: string | undefined, operation: () => Promise<T>): Promise<T> {
  if (lockPath === undefined) return operation()
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const handle = openSync(lockPath, 'wx', 0o600)
      try {
        writeSync(handle, `${process.pid}\n`)
      } catch {
        // pid 只是给人看的：写不进去不影响锁的语义
      }
      closeSync(handle)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STATE_LOCK_STALE_MS) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        continue // 锁刚被持有者释放：立刻重试
      }
      if (Date.now() >= deadline) throw new AccessError(503, 'state_busy')
      await delay(STATE_LOCK_RETRY_MS)
    }
  }
  try {
    return await operation()
  } finally {
    try {
      unlinkSync(lockPath)
    } catch {
      // 已被回收（陈旧锁路径）时不必报错
    }
  }
}

/** 便宜的文件指纹：mtime(ms)+size；文件不存在 / 不是常规文件 → undefined。 */
function stateFingerprint(file: string): string | undefined {
  try {
    const stat = statSync(file)
    if (!stat.isFile()) return undefined
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return undefined
  }
}

/**
 * 同步读一次状态文件（授权热路径专用）。
 *
 * 写盘是「临时文件 + rename」，所以读到的永远是完整内容；解析失败**抛**，
 * 由调用方决定（[AccountController.refreshSync] 选择保留内存快照，绝不因为一次
 * 读盘异常把所有人登出）。权限收敛仍由异步 [readStateFile] 负责。
 */
function readStateFileSync(file: string): unknown {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error('account state is not valid JSON', { cause: error })
  }
}

/** In-memory stores useful for embedding and deterministic tests. */
export class MemoryAccountStore implements AccountStore {
  private snapshot: AccountSnapshot

  constructor(initial: AccountSnapshot = { version: 1 }) {
    this.snapshot = parseAccountSnapshot(initial)
  }

  async load(): Promise<AccountSnapshot> {
    return structuredClone(this.snapshot)
  }

  async save(snapshot: AccountSnapshot): Promise<void> {
    this.snapshot = structuredClone(parseAccountSnapshot(snapshot))
  }

  inspect(): AccountSnapshot {
    return structuredClone(this.snapshot)
  }
}

export class MemoryTokenStore implements TokenStore {
  private snapshot: TokenSnapshot

  /** `maximum` 与 `JsonTokenStore` 同口径：测试要能盖到「表打满」这条路径。 */
  constructor(initial: TokenSnapshot = { version: 1, tokens: [] }, private readonly maximum = 256) {
    this.snapshot = parseTokenSnapshot(initial, maximum)
  }

  async load(): Promise<TokenSnapshot> {
    return structuredClone(this.snapshot)
  }

  async save(snapshot: TokenSnapshot): Promise<void> {
    this.snapshot = structuredClone(parseTokenSnapshot(snapshot, this.maximum))
  }

  inspect(): TokenSnapshot {
    return structuredClone(this.snapshot)
  }
}

/** Account verification, token issuance, revocation, and CSRF state machine. */
export class AccountController {
  private readonly now: () => number
  private readonly loginLimiter: BoundedRateLimiter
  private account: AccountRecord | undefined
  private tokens: TokenRecord[] = []
  /** 上一次见到（或写出）的盘上指纹；多进程共用目录靠它发现别人的改动。 */
  private accountRevision: string | undefined
  private tokenRevision: string | undefined
  private readonly tokenEndedListeners = new Set<(authorization: SessionAuthorization) => void>()
  private mutation: Promise<void> = Promise.resolve()
  private initialized = false
  private closing = false
  private closeTask: Promise<void> | undefined

  constructor(
    private readonly accountStore: AccountStore,
    private readonly tokenStore: TokenStore,
    private readonly options: AccountControllerOptions,
  ) {
    this.now = options.now ?? Date.now
    this.loginLimiter = new BoundedRateLimiter(
      options.maxLoginAttempts,
      options.rateLimitWindowMs,
      options.maxRateLimitKeys,
    )
  }

  /** Load durable state before accepting traffic. */
  async initialize(): Promise<void> {
    if (this.initialized || this.closing) throw new Error('account controller cannot be initialized again')
    const account = await this.accountStore.load()
    const tokens = await this.tokenStore.load()
    if (tokens.tokens.length > this.snapshotLimit) throw new Error('token state exceeds the configured token limit')
    this.account = account.account
    this.tokens = [...tokens.tokens]
    this.accountRevision = this.accountStore.revision?.()
    this.tokenRevision = this.tokenStore.revision?.()
    this.initialized = true
  }

  /**
   * 发现盘上状态被**别的进程**改过就同步读进内存（授权热路径，同步、只在文件变了时读）。
   *
   * 场景：web 与 staging 共用同一个账号目录（`accountDir`），用户在其中一台登录后
   * 立刻切到另一台——那一台必须马上认这枚 token，否则又变成「切服即掉登录」。
   * 读盘异常（半截内容等）**保留内存快照**：宁可暂时用旧表，也不能把所有人登出。
   */
  private refreshSync(): void {
    if (!this.initialized || this.closing) return
    try {
      const accountRevision = this.accountStore.revision?.()
      if (accountRevision !== undefined && accountRevision !== this.accountRevision) {
        const snapshot = this.accountStore.loadSync?.()
        if (snapshot !== undefined) {
          this.accountRevision = accountRevision
          this.account = snapshot.account
        }
      }
      const tokenRevision = this.tokenStore.revision?.()
      if (tokenRevision !== undefined && tokenRevision !== this.tokenRevision) {
        const snapshot = this.tokenStore.loadSync?.()
        if (snapshot !== undefined) {
          this.tokenRevision = tokenRevision
          this.tokens = [...snapshot.tokens]
        }
      }
    } catch {
      // 见方法说明：读盘异常不改变内存状态（下一次请求会重试）
    }
  }

  /** `tokens.json` 允许的总条数（活跃上限 + 撤销保留余量）。 */
  private get snapshotLimit(): number {
    return tokenSnapshotLimit(this.options.maxTokens)
  }

  private requireInitialized(): void {
    if (!this.initialized || this.closing) throw new Error('account controller is not available')
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.mutation
    let release!: () => void
    this.mutation = new Promise<void>(resolve => { release = resolve })
    await prior
    try {
      return await withStateLock(this.options.lockPath, async () => {
        // 锁内先对齐盘上最新状态，再让调用方基于它做读改写：否则两个进程各自的
        // 「整份快照替换」会互相覆盖（丢 token / 复活已撤销 token）。
        this.refreshSync()
        const result = await operation()
        return result
      })
    } finally {
      this.accountRevision = this.accountStore.revision?.()
      this.tokenRevision = this.tokenStore.revision?.()
      release()
    }
  }

  private snapshot(tokens: readonly TokenRecord[]): TokenSnapshot {
    return Object.freeze({ version: 1, tokens: Object.freeze([...tokens]) })
  }

  private emitTokenEnded(record: TokenRecord): void {
    const authorization = Object.freeze({
      sessionKey: tokenSessionKey(record.id),
      deviceId: tokenSessionKey(record.id),
      expiresAt: record.expiresAt,
    })
    for (const listener of this.tokenEndedListeners) listener(authorization)
  }

  private prune(now: number): TokenRecord[] {
    const retained = this.tokens.filter(token => token.revokedAt === undefined
      ? token.expiresAt > now
      : (token.revokedAt ?? 0) > now - REVOKED_RETENTION_MS)
    return retained
  }

  /** Whether a usable account exists; the App shows the setup hint when false. */
  hasAccount(): boolean {
    this.requireInitialized()
    this.refreshSync()
    return this.account !== undefined
  }

  /** Create or replace the single account. Loopback administration only. */
  async setAccount(username: string, password: string): Promise<{ username: string; tokensRevoked: number }> {
    this.requireInitialized()
    const normalized = normalizeUsername(username)
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      throw new AccessError(400, 'invalid_password')
    }
    const salt = randomBytes(16)
    const hash = await derive(password, salt, SCRYPT_COST.keylen, { ...SCRYPT_COST, maxmem: SCRYPT_MAXMEM })
    return this.exclusive(async () => {
      const now = this.now()
      const record: AccountRecord = Object.freeze({
        username: normalized,
        salt: salt.toString('base64'),
        hash: hash.toString('hex'),
        cost: Object.freeze({ ...SCRYPT_COST }),
        createdAt: this.account?.createdAt ?? now,
        updatedAt: now,
      })
      // 顺序是刻意的（fail closed）：**先吊销全部旧 token 并落盘，再落新账号**。
      // 反过来的话，第二步写盘失败会留下「新密码已生效、旧 token 仍然有效」的
      // 半成品——改密即吊销的承诺就落空了。现在最坏情况只是账号没改成（旧密码
      // 仍可登录，重新登录还能拿到新 token）。
      //
      // 注意这里是**标记撤销**而不是写空表：多进程共用同一账号目录（`accountDir`）时，
      // 空表会把别的进程刚签发的 token 一起从盘上抹掉，而对方内存里那条仍是活跃的
      // ——吊销就落空了。标记撤销对所有进程都成立（它们读盘即见 revokedAt）。
      const revoked = this.tokens.filter(token => token.revokedAt === undefined)
      const cleared = this.tokens.map(token => token.revokedAt === undefined
        ? Object.freeze({ ...token, revokedAt: now })
        : token)
      await this.tokenStore.save(this.snapshot(cleared))
      this.tokens = cleared
      await this.accountStore.save(Object.freeze({ version: 1, account: record }))
      this.account = record
      for (const token of revoked) this.emitTokenEnded({ ...token, revokedAt: now })
      return Object.freeze({ username: normalized, tokensRevoked: revoked.length })
    })
  }

  /** Verify the password and issue one one-month token (rate limited per source). */
  async login(sourceKey: string, username: string, password: string, label?: string): Promise<AccountLoginResult> {
    this.requireInitialized()
    // 共用账号目录时，账号可能是**别的进程**刚设的：先对齐盘上状态再验口令
    this.refreshSync()
    const now = this.now()
    if (!this.loginLimiter.take(sourceKey, now)) throw new AccessError(429, 'rate_limited')
    if (typeof username !== 'string' || username.length > MAX_USERNAME_LENGTH
      || typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) {
      throw new AccessError(401, 'authentication_failed')
    }
    const account = this.account
    if (account === undefined) throw new AccessError(409, 'account_not_configured')
    const salt = Buffer.from(account.salt, 'base64')
    const candidate = await derive(password, salt, account.cost.keylen, { ...account.cost, maxmem: SCRYPT_MAXMEM })
    const expected = Buffer.from(account.hash, 'hex')
    const passwordOk = candidate.length === expected.length && timingSafeEqual(candidate, expected)
    const usernameOk = timingSafeText(username.normalize('NFC').trim(), account.username)
    if (!passwordOk || !usernameOk) throw new AccessError(401, 'authentication_failed')

    const token = opaqueToken()
    const csrfToken = opaqueToken()
    const record: TokenRecord = Object.freeze({
      id: randomBytes(16).toString('hex'),
      label: normalizeLabel(label),
      tokenDigest: sha256Hex(token),
      csrfDigest: sha256Hex(csrfToken),
      createdAt: now,
      expiresAt: now + this.options.tokenTtlMs,
      lastSeenAt: now,
    })
    await this.exclusive(async () => {
      // 改密/换账号与本次登录赛跑：scrypt 期间账号可能已被替换，那就不能按旧账号
      // 的口令签发（否则旧密码换到的新 token 会被写进刚清空的表里继续可用）。
      if (this.account !== account) throw new AccessError(401, 'authentication_failed')
      const retained = this.prune(now)
      const active = retained.filter(token => token.revokedAt === undefined)
      // ① 活跃上限：多出来的先淘汰「最久没用过」的活跃 token。
      const evicted = [...active]
        .sort((left, right) => left.lastSeenAt - right.lastSeenAt)
        .slice(0, Math.max(0, active.length + 1 - this.options.maxTokens))
      // ② 快照上限：再按「最旧的撤销记录先走」腾位置——撤销记录只用于设备列表展示，
      //    丢了不影响安全（撤销判定看活表里那条记录本身，被丢的本来就已撤销）。
      const keptActive = active.filter(token => !evicted.includes(token))
      const revokedByAge = retained
        .filter(token => token.revokedAt !== undefined)
        .sort((left, right) => (left.revokedAt ?? 0) - (right.revokedAt ?? 0))
      const revokedRoom = Math.max(0, this.snapshotLimit - (keptActive.length + 1))
      const droppedRevoked = revokedByAge.slice(0, Math.max(0, revokedByAge.length - revokedRoom))
      const dropped = new Set([...evicted, ...droppedRevoked].map(token => token.id))
      const next = [...retained.filter(token => !dropped.has(token.id)), record]
      if (next.length > this.snapshotLimit) throw new Error('token table would exceed the configured limit')
      await this.tokenStore.save(this.snapshot(next))
      this.tokens = next
      for (const token of evicted) this.emitTokenEnded(token)
    })
    return Object.freeze({
      tokenId: record.id,
      token,
      csrfToken,
      expiresAt: record.expiresAt,
      username: account.username,
      label: record.label,
    })
  }

  /** Resolve a bearer credential, or return undefined when it is not our token. */
  tryAuthorize(credential: string): SessionAuthorization | undefined {
    this.requireInitialized()
    this.refreshSync()
    if (credential.length === 0 || credential.length > MAX_SECRET_LENGTH) return undefined
    const digest = sha256Hex(credential)
    const record = this.tokens.find(token => token.tokenDigest === digest)
    if (record === undefined) return undefined
    const now = this.now()
    if (record.revokedAt !== undefined || record.expiresAt <= now) throw new AccessError(401, 'authentication_failed')
    if (now - record.lastSeenAt > 60 * 60_000) {
      // lastSeenAt 只用于设备列表展示：内存里推进即可，不做每请求写盘。
      const updated: TokenRecord = Object.freeze({ ...record, lastSeenAt: now })
      const index = this.tokens.indexOf(record)
      const next = [...this.tokens]
      next[index] = updated
      this.tokens = next
    }
    return Object.freeze({
      sessionKey: tokenSessionKey(record.id),
      deviceId: tokenSessionKey(record.id),
      expiresAt: Math.min(record.expiresAt, now + AUTHORIZATION_HORIZON_MS),
    })
  }

  /** Require the token-bound anti-CSRF value for an authenticated mutation. */
  assertCsrf(authorization: SessionAuthorization, csrfToken: string | undefined): void {
    const record = this.recordForSession(authorization.sessionKey)
    if (record === undefined || csrfToken === undefined || csrfToken.length > MAX_SECRET_LENGTH
      || sha256Hex(csrfToken) !== record.csrfDigest) {
      throw new AccessError(403, 'forbidden')
    }
  }

  /** Whether the authorization came from this controller. */
  owns(sessionKey: string): boolean {
    return sessionKey.startsWith(ACCOUNT_SESSION_PREFIX)
  }

  /** Configured username, if an account exists. The password is never exposed. */
  currentUsername(): string | undefined {
    this.refreshSync()
    return this.account?.username
  }

  /** Token id encoded in an account authorization key, when it still exists. */
  tokenIdOf(sessionKey: string): string | undefined {
    if (!sessionKey.startsWith(ACCOUNT_SESSION_PREFIX)) return undefined
    const id = sessionKey.slice(ACCOUNT_SESSION_PREFIX.length)
    return this.recordForSession(sessionKey) === undefined ? undefined : id
  }

  private recordForSession(sessionKey: string): TokenRecord | undefined {
    this.refreshSync()
    if (!sessionKey.startsWith(ACCOUNT_SESSION_PREFIX)) return undefined
    const id = sessionKey.slice(ACCOUNT_SESSION_PREFIX.length)
    return this.tokens.find(token => token.id === id)
  }

  /** Revoke the presented token; returns false when it was already gone. */
  async logout(authorization: SessionAuthorization): Promise<boolean> {
    this.requireInitialized()
    const record = this.recordForSession(authorization.sessionKey)
    if (record === undefined) return false
    return this.revokeToken(record.id)
  }

  /** Revoke one token by id and abort everything attached to it. */
  async revokeToken(id: string): Promise<boolean> {
    this.requireInitialized()
    return this.exclusive(async () => {
      const index = this.tokens.findIndex(token => token.id === id)
      const record = this.tokens[index]
      if (record === undefined || record.revokedAt !== undefined) return false
      const updated: TokenRecord = Object.freeze({ ...record, revokedAt: this.now() })
      const next = [...this.tokens]
      next[index] = updated
      await this.tokenStore.save(this.snapshot(next))
      this.tokens = next
      this.emitTokenEnded(updated)
      return true
    })
  }

  /** Revoke every token (panic button / password change). */
  async revokeAll(): Promise<number> {
    this.requireInitialized()
    return this.exclusive(async () => {
      const active = this.tokens.filter(token => token.revokedAt === undefined)
      if (active.length === 0) return 0
      const now = this.now()
      const next = this.tokens.map(token => token.revokedAt === undefined
        ? Object.freeze({ ...token, revokedAt: now })
        : token)
      await this.tokenStore.save(this.snapshot(next))
      this.tokens = next
      for (const token of active) this.emitTokenEnded({ ...token, revokedAt: now })
      return active.length
    })
  }

  /** Safe metadata for the sign-in device list, newest first. */
  listTokens(): readonly AccountTokenSummary[] {
    this.requireInitialized()
    // 共用账号目录时，设备列表要显示**别的服务**签发的 token（统一鉴权下它们都算本账号的登录）
    this.refreshSync()
    return Object.freeze([...this.tokens]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(token => Object.freeze({
        id: token.id,
        label: token.label,
        createdAt: token.createdAt,
        expiresAt: token.expiresAt,
        lastSeenAt: token.lastSeenAt,
        ...(token.revokedAt === undefined ? {} : { revokedAt: token.revokedAt }),
      })))
  }

  /** Subscribe gateway resources to token revocation and eviction. */
  onTokenEnded(listener: (authorization: SessionAuthorization) => void): () => void {
    this.tokenEndedListeners.add(listener)
    return () => { this.tokenEndedListeners.delete(listener) }
  }

  /** Stop new operations, flush durable state, then clear volatile state. */
  close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask
    this.closing = true
    this.closeTask = this.finishClose()
    return this.closeTask
  }

  private async finishClose(): Promise<void> {
    await this.mutation
    if (this.initialized) {
      try {
        await this.tokenStore.save(this.snapshot(this.prune(this.now())))
      } catch {
        // 关闭路径尽力而为：落盘失败不应阻止进程退出。
      }
    }
    this.tokenEndedListeners.clear()
    this.initialized = false
  }

  /** Bounded volatile-state metrics for tests and local status. */
  metrics(): { tokens: number; rateLimitKeys: number } {
    return Object.freeze({ tokens: this.tokens.length, rateLimitKeys: this.loginLimiter.size })
  }
}

/** Account authorizations are distinguishable from legacy session keys by prefix. */
export const ACCOUNT_SESSION_PREFIX = 'acct:'

function tokenSessionKey(id: string): string {
  return `${ACCOUNT_SESSION_PREFIX}${id}`
}
