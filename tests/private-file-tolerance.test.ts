import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `restrictPrivateFile` 的**失败口径**（0.3.43）——与 `private-file.test.ts` 分开放，
 * 因为这里要 mock 掉 `chmod`，而同名文件的用例断言的是「真实 chmod 之后模式确实是
 * 0600」，两件事不能在同一个模块图里共存。
 *
 * 背景：三服共用同一个账号目录时，自救服务跑 root、正式服/测试服跑 feiyueve。
 * `readStateFile()` **每次读盘前都会 chmod**，而 `Gateway.start()` 又把
 * `account.initialize()` 放在 try 之外——老实现「chmod 失败就抛」意味着
 * **别 uid 写过账号表之后，另一个 uid 下次启动时整个 dsh-mobile 插件加载失败**
 * （18443/18452 网关直接起不来）。所以这一层必须精确：只有「不是属主」被容忍，
 * 其它错误（ENOENT 之类）照旧抛，且容忍时每个路径只刷一条警告。
 *
 * mock 只替换 `chmod`，其余 `node:fs/promises` 导出保持真实实现（`importOriginal`）。
 */
const chmodMock = vi.hoisted(() => vi.fn(async (_file: string, _mode?: number): Promise<void> => {}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, chmod: chmodMock }
})

const { restrictPrivateFile } = await import('../src/private-file.js')

/** 造一个带 `code` 的 fs 风格错误。 */
function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: mocked`), { code })
}

let warn: ReturnType<typeof vi.spyOn>
let pathCounter = 0

/** 每个用例用互不相同的路径——`toleratedPaths` 是模块级状态，复用会让「只警告一次」失真。 */
function uniquePath(): string {
  pathCounter += 1
  return `/home/feiyueve/.dsh/mobile-access/case-${String(pathCounter)}.json`
}

beforeEach(() => {
  chmodMock.mockReset()
  chmodMock.mockImplementation(async () => {})
  warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
})

afterEach(() => { vi.restoreAllMocks() })

describe('restrictPrivateFile 的容忍口径', () => {
  it('默认按 0600 收紧，收得住就静默成功、不刷警告', async () => {
    const file = uniquePath()
    await expect(restrictPrivateFile(file)).resolves.toBeUndefined()
    expect(chmodMock).toHaveBeenCalledTimes(1)
    expect(chmodMock).toHaveBeenCalledWith(file, 0o600)
    expect(warn).not.toHaveBeenCalled()
  })

  it('按调用方给的模式收紧（共享账号目录用 0o640）', async () => {
    const file = uniquePath()
    await restrictPrivateFile(file, 0o640)
    expect(chmodMock).toHaveBeenCalledWith(file, 0o640)
    expect(warn).not.toHaveBeenCalled()
  })

  it('非属主（EPERM）被容忍：不抛、留一条警告、同一个路径只警告一次', async () => {
    const file = uniquePath()
    chmodMock.mockRejectedValue(fsError('EPERM'))

    await expect(restrictPrivateFile(file, 0o640)).resolves.toBeUndefined()
    await expect(restrictPrivateFile(file, 0o640)).resolves.toBeUndefined()

    // 每次调用都真的试了（不是「记住失败就跳过」），只是失败被咽下去。
    expect(chmodMock).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toContain('dsh-mobile')
    expect(message).toContain(file)
    expect(message).toContain('EPERM')
  })

  it('EACCES 同样被容忍（不同路径各警告一次）', async () => {
    const first = uniquePath()
    const second = uniquePath()
    chmodMock.mockRejectedValue(fsError('EACCES'))

    await expect(restrictPrivateFile(first)).resolves.toBeUndefined()
    await expect(restrictPrivateFile(second)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('其它错误照旧抛（ENOENT 是真问题，不是权限位问题）', async () => {
    const file = uniquePath()
    chmodMock.mockRejectedValue(fsError('ENOENT'))

    await expect(restrictPrivateFile(file)).rejects.toThrow(/ENOENT/u)
    expect(warn).not.toHaveBeenCalled()
  })

  it('没有 code 的错误也算真问题，不被当成权限位咽掉', async () => {
    const file = uniquePath()
    chmodMock.mockRejectedValue(new Error('nope'))

    await expect(restrictPrivateFile(file)).rejects.toThrow(/nope/u)
  })

  it('成功与失败交替时互不影响：先 EPERM 后成功，成功那次不刷警告', async () => {
    const first = uniquePath()
    const second = uniquePath()
    chmodMock.mockRejectedValueOnce(fsError('EPERM'))

    await expect(restrictPrivateFile(first)).resolves.toBeUndefined()
    await expect(restrictPrivateFile(second)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain(first)
  })
})
