import { lstat, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccessError } from '../src/access.js'
import {
  AUTHORIZATION_HORIZON_MS,
  AccountController,
  DEFAULT_TOKEN_TTL_MS,
  JsonAccountStore,
  JsonTokenStore,
  MemoryAccountStore,
  MemoryTokenStore,
  tokenSnapshotLimit,
  type AccountControllerOptions,
  type AccountSnapshot,
  type AccountStore,
} from '../src/account.js'
import { createTempDirectory } from './tmp-root.js'

const USERNAME = 'feiyueve'
const PASSWORD = 'hmw-correct-horse-battery'

// 项目产物不落 /tmp：测试工作目录一律放仓库根 `.tmp/`（已在 .gitignore）。
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await createTempDirectory(prefix)
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function options(overrides: Partial<AccountControllerOptions> = {}): AccountControllerOptions {
  return {
    tokenTtlMs: DEFAULT_TOKEN_TTL_MS,
    maxTokens: 8,
    rateLimitWindowMs: 60_000,
    maxLoginAttempts: 5,
    maxRateLimitKeys: 64,
    ...overrides,
  }
}

async function configured(overrides: Partial<AccountControllerOptions> = {}): Promise<{
  account: AccountController
  accountStore: MemoryAccountStore
  tokenStore: MemoryTokenStore
}> {
  const accountStore = new MemoryAccountStore()
  const tokenStore = new MemoryTokenStore()
  const account = new AccountController(accountStore, tokenStore, options(overrides))
  await account.initialize()
  await account.setAccount(USERNAME, PASSWORD)
  return { account, accountStore, tokenStore }
}

describe('account authority', () => {
  it('stores only a scrypt hash, never the plaintext password', async () => {
    const { accountStore } = await configured()
    const record = accountStore.inspect().account
    expect(record?.username).toBe(USERNAME)
    expect(record?.hash).toMatch(/^[a-f\d]{64}$/u)
    expect(record?.salt).toMatch(/^[A-Za-z\d+/]+={0,2}$/u)
    expect(record?.cost).toEqual({ N: 32_768, r: 8, p: 1, keylen: 32 })
    expect(JSON.stringify(accountStore.inspect())).not.toContain(PASSWORD)
  })

  it('reports an unconfigured account instead of accepting any login', async () => {
    const account = new AccountController(new MemoryAccountStore(), new MemoryTokenStore(), options())
    await account.initialize()
    expect(account.hasAccount()).toBe(false)
    await expect(account.login('127.0.0.1', USERNAME, PASSWORD)).rejects.toMatchObject({ code: 'account_not_configured' })
  })

  it('issues a one-month credential and keeps only its digest', async () => {
    const now = 1_700_000_000_000
    const { account, tokenStore } = await configured({ now: () => now })
    const issued = await account.login('127.0.0.1', USERNAME, PASSWORD, 'Pixel')
    expect(issued.token).toMatch(/^[\w-]{43}$/u)
    expect(issued.csrfToken).toMatch(/^[\w-]{43}$/u)
    expect(issued.expiresAt - now).toBe(DEFAULT_TOKEN_TTL_MS)
    const persisted = JSON.stringify(tokenStore.inspect())
    expect(persisted).not.toContain(issued.token)
    expect(persisted).not.toContain(issued.csrfToken)
    expect(persisted).toContain(issued.tokenId)
    expect(tokenStore.inspect().tokens[0]?.label).toBe('Pixel')
  })

  it('survives a restart: the credential is durable, not an in-memory session', async () => {
    const accountStore = new MemoryAccountStore()
    const tokenStore = new MemoryTokenStore()
    const first = new AccountController(accountStore, tokenStore, options())
    await first.initialize()
    await first.setAccount(USERNAME, PASSWORD)
    const issued = await first.login('127.0.0.1', USERNAME, PASSWORD)
    await first.close()

    const second = new AccountController(accountStore, tokenStore, options())
    await second.initialize()
    expect(second.tryAuthorize(issued.token)?.sessionKey).toBe(`acct:${issued.tokenId}`)
    expect(second.hasAccount()).toBe(true)
    await second.close()
  })

  it('clamps the authorization horizon below the 32-bit timer bound', async () => {
    const now = 1_700_000_000_000
    const { account } = await configured({ now: () => now })
    const issued = await account.login('127.0.0.1', USERNAME, PASSWORD)
    const authorization = account.tryAuthorize(issued.token)
    expect(authorization).toBeDefined()
    // 网关 allocateRequest 用 setTimeout(expiresAt - now)：超过 2^31-1 ms 会被
    // Node 截断成 1ms。30 天 > 24.8 天，所以授权视界必须钳住。
    expect(AUTHORIZATION_HORIZON_MS).toBeLessThan(2 ** 31 - 1)
    expect((authorization?.expiresAt ?? 0) - now).toBeLessThanOrEqual(AUTHORIZATION_HORIZON_MS)
    expect(issued.expiresAt - now).toBe(DEFAULT_TOKEN_TTL_MS)
  })

  it('stops accepting the credential once the month is over', async () => {
    let clock = 1_700_000_000_000
    const { account } = await configured({ now: () => clock })
    const issued = await account.login('127.0.0.1', USERNAME, PASSWORD)
    clock += DEFAULT_TOKEN_TTL_MS - 1
    expect(account.tryAuthorize(issued.token)).toBeDefined()
    clock += 2
    expect(() => account.tryAuthorize(issued.token)).toThrow(AccessError)
  })

  it('rejects wrong passwords, unknown users, and throttles repeated failures', async () => {
    const { account } = await configured({ maxLoginAttempts: 2 })
    await expect(account.login('127.0.0.1', USERNAME, 'wrong-password')).rejects.toMatchObject({ status: 401 })
    await expect(account.login('127.0.0.1', 'someone-else', PASSWORD)).rejects.toMatchObject({ status: 401 })
    await expect(account.login('127.0.0.1', USERNAME, PASSWORD)).rejects.toMatchObject({ status: 429 })
    // 限流按来源地址计：另一个来源不受影响。
    await expect(account.login('127.0.0.2', USERNAME, PASSWORD)).resolves.toMatchObject({ username: USERNAME })
  })

  it('binds CSRF to the credential and fails closed', async () => {
    const { account } = await configured()
    const issued = await account.login('127.0.0.1', USERNAME, PASSWORD)
    const authorization = account.tryAuthorize(issued.token)
    expect(authorization).toBeDefined()
    expect(() => account.assertCsrf(authorization!, issued.csrfToken)).not.toThrow()
    expect(() => account.assertCsrf(authorization!, undefined)).toThrow(AccessError)
    expect(() => account.assertCsrf(authorization!, 'guessed')).toThrow(AccessError)
  })

  it('does not let a token authorize another token table entry', async () => {
    const { account } = await configured()
    const first = await account.login('127.0.0.1', USERNAME, PASSWORD, 'One')
    const second = await account.login('127.0.0.1', USERNAME, PASSWORD, 'Two')
    const authorization = account.tryAuthorize(first.token)
    expect(() => account.assertCsrf(authorization!, second.csrfToken)).toThrow(AccessError)
  })

  it('revokes a credential, ends its resources, and reports it as revoked afterwards', async () => {
    const { account } = await configured()
    const issued = await account.login('127.0.0.1', USERNAME, PASSWORD)
    const ended: string[] = []
    account.onTokenEnded(authorization => { ended.push(authorization.sessionKey) })
    await expect(account.revokeToken(issued.tokenId)).resolves.toBe(true)
    expect(ended).toEqual([`acct:${issued.tokenId}`])
    expect(() => account.tryAuthorize(issued.token)).toThrow(AccessError)
    await expect(account.revokeToken(issued.tokenId)).resolves.toBe(false)
    expect(account.listTokens()[0]?.revokedAt).toBeTypeOf('number')
  })

  it('revokes every credential when the password changes', async () => {
    const { account } = await configured()
    const first = await account.login('127.0.0.1', USERNAME, PASSWORD)
    const second = await account.login('127.0.0.1', USERNAME, PASSWORD)
    await expect(account.setAccount(USERNAME, 'a-brand-new-password')).resolves.toMatchObject({ tokensRevoked: 2 })
    // 改密把表里**所有活跃 token 标记撤销**（不再写空表）：多进程共用账号目录时，
    // 空表会连同别的进程的 token 一起丢掉，而对方内存里那条仍算活跃 —— 「改密即吊销」
    // 就落空了。代价是设备列表会多出「已撤销」记录（保留 7 天，与单条撤销同一口径）；
    // 两种拒绝路径（不在表里 / 在表里但已撤销）对客户端都是 401，安全语义不变。
    expect(() => account.tryAuthorize(first.token)).toThrow(AccessError)
    expect(() => account.tryAuthorize(second.token)).toThrow(AccessError)
    expect(account.listTokens()).toHaveLength(2)
    expect(account.listTokens().every(token => token.revokedAt !== undefined)).toBe(true)
    await expect(account.login('127.0.0.1', USERNAME, PASSWORD)).rejects.toMatchObject({ status: 401 })
    await expect(account.login('127.0.0.1', USERNAME, 'a-brand-new-password')).resolves.toMatchObject({ username: USERNAME })
  })

  it('evicts the least recently used credential at the configured ceiling', async () => {
    let clock = 1_700_000_000_000
    const { account } = await configured({ maxTokens: 2, now: () => clock })
    const first = await account.login('127.0.0.1', USERNAME, PASSWORD, 'First')
    clock += 1_000
    const second = await account.login('127.0.0.1', USERNAME, PASSWORD, 'Second')
    // lastSeenAt 只在超过 1 小时后才在内存里推进（避免每请求写盘），
    // 所以先跨过这个粒度，再让第一枚变成「最近用过」。
    clock += 60 * 60_000 + 1
    account.tryAuthorize(first.token)
    clock += 1_000
    const third = await account.login('127.0.0.1', USERNAME, PASSWORD, 'Third')
    expect(account.listTokens()).toHaveLength(2)
    expect(account.listTokens().map(token => token.label).sort()).toEqual(['First', 'Third'])
    expect(account.tryAuthorize(second.token)).toBeUndefined()
    expect(account.tryAuthorize(first.token)).toBeDefined()
    expect(account.tryAuthorize(third.token)).toBeDefined()
  })

  it('round-trips owner-only files and refuses a symlinked state file', async () => {
    const directory = await tempDirectory('dsh-mobile-account-')
    const accountFile = join(directory, 'account.json')
    const tokenFile = join(directory, 'tokens.json')
    const accountStore = new JsonAccountStore(accountFile)
    const tokenStore = new JsonTokenStore(tokenFile)
    const account = new AccountController(accountStore, tokenStore, options())
    await account.initialize()
    await account.setAccount(USERNAME, PASSWORD)
    const issued = await account.login('127.0.0.1', USERNAME, PASSWORD)
    await account.close()

    expect((await lstat(accountFile)).mode & 0o777).toBe(0o600)
    expect((await lstat(tokenFile)).mode & 0o777).toBe(0o600)
    expect(await readFile(accountFile, 'utf8')).not.toContain(PASSWORD)

    const reloaded = new AccountController(new JsonAccountStore(accountFile), new JsonTokenStore(tokenFile), options())
    await reloaded.initialize()
    expect(reloaded.tryAuthorize(issued.token)?.deviceId).toBe(`acct:${issued.tokenId}`)
    await reloaded.close()

    const decoy = join(directory, 'decoy.json')
    await writeFile(decoy, '{"version":1}\n', { encoding: 'utf8', mode: 0o600 })
    const link = join(directory, 'linked.json')
    await symlink(decoy, link)
    await expect(new JsonAccountStore(link).load()).rejects.toThrow(/regular file/u)
  })

  it('keeps issuing tokens after the active ceiling is hit and one is revoked (B1 regression)', async () => {
    // B1：`maxTokens` 是「活跃上限」，不是 tokens.json 的长度上限。曾经 JsonTokenStore
    // 拿活跃上限当解析上限，于是「活跃打满 → 踢掉一枚 → 再登录」写出 N+1 条快照，
    // 下次 load/save 直接抛 `token state has an unsupported version or token count`，
    // 登录从此 500。tokenSnapshotLimit(N) 就是那条余量。
    const directory = await tempDirectory('dsh-mobile-token-limit-')
    const accountFile = join(directory, 'account.json')
    const tokenFile = join(directory, 'tokens.json')
    const maximum = 4
    const first = new AccountController(
      new JsonAccountStore(accountFile),
      new JsonTokenStore(tokenFile, tokenSnapshotLimit(maximum)),
      options({ maxTokens: maximum }),
    )
    await first.initialize()
    await first.setAccount(USERNAME, PASSWORD)

    const issued: Awaited<ReturnType<typeof first.login>>[] = []
    for (let index = 0; index < maximum; index += 1) {
      issued.push(await first.login('127.0.0.1', USERNAME, PASSWORD, `Phone ${String(index)}`))
    }
    expect(first.listTokens().filter(token => token.revokedAt === undefined)).toHaveLength(maximum)

    await expect(first.revokeToken(issued[0]!.tokenId)).resolves.toBe(true)
    // 关键断言：活跃已打满且表里多了一条撤销记录，这一步以前会抛错。
    const replacement = await first.login('127.0.0.1', USERNAME, PASSWORD, 'Replacement')
    expect(replacement.token).toMatch(/^[\w-]{43}$/u)
    expect(first.listTokens().length).toBeLessThanOrEqual(tokenSnapshotLimit(maximum))
    expect(first.listTokens().filter(token => token.revokedAt === undefined)).toHaveLength(maximum)
    // 被踢掉的那枚是「在表里但已撤销」——显式 401，不是回落。
    expect(() => first.tryAuthorize(issued[0]!.token)).toThrow(AccessError)
    await first.close()

    // 同一份文件必须能被新控制器重新读回（「登录从此 500」的那条路径）。
    const reloaded = new AccountController(
      new JsonAccountStore(accountFile),
      new JsonTokenStore(tokenFile, tokenSnapshotLimit(maximum)),
      options({ maxTokens: maximum }),
    )
    await expect(reloaded.initialize()).resolves.toBeUndefined()
    expect(reloaded.tryAuthorize(replacement.token)?.sessionKey).toBe(`acct:${replacement.tokenId}`)
    await reloaded.close()
  })

  it('fails closed when the new account cannot be written beside live tokens', async () => {
    // setAccount 的顺序是刻意的：先吊销全部旧 token 并落盘，再落新账号。
    // 用「保存账号必失败」的 store seam 把第二步打断，验证半成品状态不存在：
    // 账号保持旧密码（新密码无效），而旧 token 已经全部作废。
    class FailingAccountStore implements AccountStore {
      constructor(private readonly snapshot: AccountSnapshot) {}
      async load(): Promise<AccountSnapshot> { return structuredClone(this.snapshot) }
      async save(): Promise<void> { throw new Error('account store write failed') }
    }

    const seedAccounts = new MemoryAccountStore()
    const seedTokens = new MemoryTokenStore()
    const seed = new AccountController(seedAccounts, seedTokens, options())
    await seed.initialize()
    await seed.setAccount(USERNAME, PASSWORD)
    const first = await seed.login('127.0.0.1', USERNAME, PASSWORD, 'Old one')
    const second = await seed.login('127.0.0.1', USERNAME, PASSWORD, 'Old two')
    await seed.close()

    const account = new AccountController(
      new FailingAccountStore(seedAccounts.inspect()),
      new MemoryTokenStore(seedTokens.inspect()),
      options(),
    )
    await account.initialize()
    expect(account.hasAccount()).toBe(true)
    expect(account.tryAuthorize(first.token)).toBeDefined()

    await expect(account.setAccount(USERNAME, 'a-brand-new-password')).rejects.toThrow(/account store write failed/u)

    // 账号没变：旧用户名仍在位、旧密码仍可登录、新密码无效。
    expect(account.currentUsername()).toBe(USERNAME)
    expect(account.hasAccount()).toBe(true)
    await expect(account.login('127.0.0.1', USERNAME, 'a-brand-new-password')).rejects.toMatchObject({ status: 401 })
    // 旧 token 已吊销：改密失败也不会留下「新密码未生效、旧 token 仍可用」的旁路。
    // 注意吊销是**标记**（记录留在表里 → tryAuthorize 判 401 抛出）而不是删记录：
    // 多进程共用账号目录时删记录会让别的进程内存里那条仍算活跃（见 setAccount 注释）。
    expect(() => account.tryAuthorize(first.token)).toThrow(AccessError)
    expect(() => account.tryAuthorize(second.token)).toThrow(AccessError)
    await expect(account.login('127.0.0.1', USERNAME, PASSWORD)).resolves.toMatchObject({ username: USERNAME })
  })
})

/**
 * 三服统一鉴权：多个 dsh 进程共用同一个账号目录（`accountDir`）。
 *
 * 这几条钉的是「一台登录、另一台立刻认；一台撤销、另一台立刻失效；并发登录不互相
 * 覆盖；改密吊销所有进程」。不需要这些保证时（单进程）行为与从前一致。
 */
describe('shared account directory', () => {
  function shared(directory: string): AccountController {
    return new AccountController(
      new JsonAccountStore(join(directory, 'account.json')),
      new JsonTokenStore(join(directory, 'tokens.json')),
      options({ lockPath: join(directory, '.account.lock') }),
    )
  }

  it('另一台进程无需重启就认新签发的 token（读路径按文件指纹刷新）', async () => {
    const directory = await tempDirectory('account-shared-')
    const web = shared(directory)
    const staging = shared(directory)
    await web.initialize()
    await staging.initialize()
    await web.setAccount(USERNAME, PASSWORD)

    // staging 的内存快照停在「登录之前」——它必须自己发现盘变了
    const issued = await web.login('lan-web', USERNAME, PASSWORD, 'DSH Mobile (Flutter)')
    expect(staging.tryAuthorize(issued.token)).toMatchObject({ sessionKey: `acct:${issued.tokenId}` })
    // csrf 也要跨进程成立（WebView 的变更请求靠它）
    expect(() => staging.assertCsrf(staging.tryAuthorize(issued.token)!, issued.csrfToken)).not.toThrow()
  })

  it('一台撤销，另一台立刻失效', async () => {
    const directory = await tempDirectory('account-shared-')
    const web = shared(directory)
    const staging = shared(directory)
    await web.initialize()
    await staging.initialize()
    await web.setAccount(USERNAME, PASSWORD)
    const issued = await web.login('lan-web', USERNAME, PASSWORD)

    const authorization = staging.tryAuthorize(issued.token)!
    await expect(staging.logout(authorization)).resolves.toBe(true)
    expect(() => web.tryAuthorize(issued.token)).toThrow(AccessError)
  })

  it('两台并发登录不会互相覆盖（跨进程锁 + 锁内对齐盘上状态）', async () => {
    const directory = await tempDirectory('account-shared-')
    const web = shared(directory)
    const staging = shared(directory)
    await web.initialize()
    await staging.initialize()
    await web.setAccount(USERNAME, PASSWORD)

    const [fromWeb, fromStaging] = await Promise.all([
      web.login('lan-web', USERNAME, PASSWORD, 'web'),
      staging.login('lan-staging', USERNAME, PASSWORD, 'staging'),
    ])
    // 两枚都在盘上，且两边都能认对方那枚
    expect(web.listTokens()).toHaveLength(2)
    expect(staging.listTokens()).toHaveLength(2)
    expect(web.tryAuthorize(fromStaging.token)).toBeDefined()
    expect(staging.tryAuthorize(fromWeb.token)).toBeDefined()
  })

  it('改密是「全部标记撤销」而不是清空表：别的进程的 token 也失效', async () => {
    const directory = await tempDirectory('account-shared-')
    const web = shared(directory)
    const staging = shared(directory)
    await web.initialize()
    await staging.initialize()
    await web.setAccount(USERNAME, PASSWORD)
    const issued = await web.login('lan-web', USERNAME, PASSWORD)

    const result = await staging.setAccount(USERNAME, 'a-brand-new-password')
    expect(result.tokensRevoked).toBe(1)
    expect(() => web.tryAuthorize(issued.token)).toThrow(AccessError)
    // 记录仍在（撤销是标记），旧密码失效、新密码可用
    const raw = JSON.parse(await readFile(join(directory, 'tokens.json'), 'utf8')) as { tokens: unknown[] }
    expect(raw.tokens).toHaveLength(1)
    await expect(web.login('lan-web', USERNAME, PASSWORD)).rejects.toMatchObject({ status: 401 })
    await expect(web.login('lan-web', USERNAME, 'a-brand-new-password')).resolves.toMatchObject({ username: USERNAME })
  })

  it('持有者崩溃留下的陈旧锁会被回收（不会把登录永久卡死）', async () => {
    const directory = await tempDirectory('account-shared-')
    const web = shared(directory)
    await web.initialize()
    await web.setAccount(USERNAME, PASSWORD)
    const lock = join(directory, '.account.lock')
    await writeFile(lock, '999999\n')
    const past = new Date(Date.now() - 60_000)
    await utimes(lock, past, past)

    await expect(web.login('lan-web', USERNAME, PASSWORD)).resolves.toMatchObject({ username: USERNAME })
    await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
