import { statSync } from 'node:fs'
import { lstat, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
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

  it('跨 uid 共用账号目录：模式按构造参数落盘（0o640），共享组可读写、other 什么也没有', async () => {
    // 部署形态 = 自救服务（root）与正式服/测试服（feiyueve）读同一份账号表，
    // 所以写方必须落得出 0640（目录 setgid 到共享组，新文件继承组）。
    const directory = await tempDirectory('dsh-mobile-account-shared-')
    const accountFile = join(directory, 'account.json')
    const tokenFile = join(directory, 'tokens.json')
    const maximum = 4
    const shared = new AccountController(
      new JsonAccountStore(accountFile, 0o640),
      new JsonTokenStore(tokenFile, tokenSnapshotLimit(maximum), 0o640),
      options({ maxTokens: maximum }),
    )
    await shared.initialize()
    await shared.setAccount(USERNAME, PASSWORD)
    const issued = await shared.login('127.0.0.1', USERNAME, PASSWORD, 'Shared')
    await shared.close()

    expect((await lstat(accountFile)).mode & 0o777).toBe(0o640)
    expect((await lstat(tokenFile)).mode & 0o777).toBe(0o640)

    // 另一个进程按同一模式接手（= 另一台服务读同一份表）：模式只影响落盘，
    // 不影响读回与授权，token 照旧有效。
    const reader = new AccountController(
      new JsonAccountStore(accountFile, 0o640),
      new JsonTokenStore(tokenFile, tokenSnapshotLimit(maximum), 0o640),
      options({ maxTokens: maximum }),
    )
    await reader.initialize()
    expect(reader.tryAuthorize(issued.token)?.deviceId).toBe(`acct:${issued.tokenId}`)
    await reader.close()

    // 不配模式的那份仍是 0600——共享改造不许把默认口径带松。
    const soloAccount = join(directory, 'solo-account.json')
    const solo = new AccountController(
      new JsonAccountStore(soloAccount),
      new JsonTokenStore(join(directory, 'solo-tokens.json'), tokenSnapshotLimit(maximum)),
      options({ maxTokens: maximum }),
    )
    await solo.initialize()
    await solo.setAccount(USERNAME, PASSWORD)
    await solo.close()
    expect((await lstat(soloAccount)).mode & 0o777).toBe(0o600)
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

  /**
   * 2026-10-11 真机事故的回归：staging 撤销一枚 token，300 ms 后 **web 关闭**时的整表
   * 写回把这条撤销整条抹掉（盘上那枚凭据复活了 26 分钟）。关闭路径从前是「拿内存表直接
   * save」，既不看盘、也不拿锁——凡是「另一台刚写过、这台内存还停在之前」都会中招。
   */
  it('一台关闭时的整表写回不得抹掉另一台刚签发的 token', async () => {
    const directory = await tempDirectory('account-shared-')
    const web = shared(directory)
    const staging = shared(directory)
    await web.initialize()
    await staging.initialize()
    await web.setAccount(USERNAME, PASSWORD)

    // web 的内存停在「登录之前」，staging 刚签发一枚，紧接着 web 关闭。
    const issued = await staging.login('lan-staging', USERNAME, PASSWORD, 'staging')
    await web.close()

    const raw = JSON.parse(await readFile(join(directory, 'tokens.json'), 'utf8')) as { tokens: Array<{ id: string }> }
    expect(raw.tokens.map(token => token.id)).toContain(issued.tokenId)
    const restarted = shared(directory)
    await restarted.initialize()
    expect(restarted.tryAuthorize(issued.token)).toMatchObject({ sessionKey: `acct:${issued.tokenId}` })
  })

  it('一台关闭时的整表写回不得让已撤销的 token 复活', async () => {
    const directory = await tempDirectory('account-shared-')
    const web = shared(directory)
    await web.initialize()
    await web.setAccount(USERNAME, PASSWORD)
    const issued = await web.login('lan-web', USERNAME, PASSWORD)
    // 另一台的内存停在「撤销之前」：它的关闭写回就是复活那条路径。
    const stale = shared(directory)
    await stale.initialize()
    await web.logout(web.tryAuthorize(issued.token)!)

    await stale.close()
    const raw = JSON.parse(await readFile(join(directory, 'tokens.json'), 'utf8')) as { tokens: Array<{ revokedAt?: number }> }
    expect(raw.tokens[0]?.revokedAt).toBeTypeOf('number')
    const restarted = shared(directory)
    await restarted.initialize()
    expect(() => restarted.tryAuthorize(issued.token)).toThrow(AccessError)
  })

  it('读不出盘时既不在关闭路径写盘、也不在变更路径写盘（宁可失败，不覆盖）', async () => {
    const directory = await tempDirectory('account-shared-')
    const web = shared(directory)
    await web.initialize()
    await web.setAccount(USERNAME, PASSWORD)
    await web.login('lan-web', USERNAME, PASSWORD)
    const file = join(directory, 'tokens.json')
    const garbage = 'not json at all'
    await writeFile(file, garbage)

    // 变更路径：503（可重试）而不是拿陈旧内存整表覆盖
    await expect(web.login('lan-web', USERNAME, PASSWORD)).rejects.toMatchObject({ status: 503 })
    expect(await readFile(file, 'utf8')).toBe(garbage)
    // 关闭路径：同样是「不写」
    await web.close()
    expect(await readFile(file, 'utf8')).toBe(garbage)
  })

  it('陈旧锁删不掉时按拿不到锁收口，不空转（deadline 必须生效）', async () => {
    const directory = await tempDirectory('account-shared-')
    const web = shared(directory)
    await web.initialize()
    await web.setAccount(USERNAME, PASSWORD)
    // 目录冒充锁文件：`unlinkSync` 必然失败（EISDIR），而它又是陈旧的 → 回收分支失败后
    // 必须落到 deadline，而不是 `continue` 死循环。
    const lock = join(directory, '.account.lock')
    await mkdir(lock)
    const past = new Date(Date.now() - 60_000)
    await utimes(lock, past, past)

    const started = Date.now()
    await expect(web.login('lan-web', USERNAME, PASSWORD)).rejects.toMatchObject({ status: 503 })
    expect(Date.now() - started).toBeLessThan(8_000)
  }, 20_000)
})

/**
 * 文件指纹是「另一台进程有没有改过盘」的唯一判据（每个请求都要比对一次，所以不能哈希
 * 全文）。它必须能区分**同一毫秒内、长度也相同**的两次写盘，否则那一次改动会被当成
 * 「没变」，进程继续拿陈旧内存表整表写回。
 */
describe('state fingerprint', () => {
  it('内容与长度相同、mtime 完全相同（同一毫秒）的两次写，指纹仍然不同（ino 参与）', async () => {
    const directory = await tempDirectory('account-fingerprint-')
    const file = join(directory, 'tokens.json')
    const store = new JsonTokenStore(file)
    // 整数毫秒的时间戳：ext4 存到 ns，写回去再读出来能精确相同，前提才可复现。
    const stamp = new Date(1_700_000_000_000)

    await store.save({ version: 1, tokens: [] })
    await utimes(file, stamp, stamp)
    const first = store.revision()
    expect(first).toBeTypeOf('string')
    const before = statSync(file)
    expect(before.mtimeMs).toBe(stamp.getTime())

    await store.save({ version: 1, tokens: [] })
    await utimes(file, stamp, stamp)
    const after = statSync(file)
    // 前提：只靠 `mtimeMs:size` 完全看不出盘被重写过（这正是旧指纹的漏点）
    expect(`${after.mtimeMs}:${after.size}`).toBe(`${before.mtimeMs}:${before.size}`)

    expect(store.revision()).not.toBe(first)
  })
})
