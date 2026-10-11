import { execFile as execFileCallback } from 'node:child_process'
import { chmod } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
let userSidTask: Promise<string> | undefined

async function currentWindowsUserSid(): Promise<string> {
  userSidTask ??= execFile('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  }).then(({ stdout }) => {
    const match = /,"(S-\d(?:-\d+)+)"\s*$/u.exec(stdout.trim())
    if (match?.[1] === undefined) throw new Error('unable to resolve the current Windows user SID')
    return match[1]
  })
  return userSidTask
}

/** 已因「不是属主」跳过一次收紧的路径（避免每次读盘都刷同一条警告）。 */
const toleratedPaths = new Set<string>()

/**
 * Restrict a sensitive regular file to the current user and Windows administrators.
 *
 * **非属主不抛**（2026-10-11，0.3.43）：多进程共用同一个账号目录时（本机形态 =
 * 自救服务跑 root、正式服/测试服跑 feiyueve），读的一方 **chmod 必然 EPERM**。
 * 老实现直接抛，而 `readStateFile()` 每次读盘前都会 chmod、`Gateway.start()` 又把
 * `account.initialize()` 放在 try 之外 ⇒ 只要别 uid 写过账号表，另一个 uid
 * **下次启动时整个 dsh-mobile 插件加载失败**（18443/18452 网关直接起不来）。
 * 这只是权限位问题、不是数据损坏：模式该由**写方**按 `accountFileMode` 设好
 * （共享场景配 0640 + 共享组），读方读得到就行，收紧失败不该让进程起不来。
 *
 * 其它错误照旧抛（ENOENT 之类才是真问题）。
 */
export async function restrictPrivateFile(file: string, mode = 0o600): Promise<void> {
  try {
    await chmod(file, mode)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EACCES') throw error
    if (!toleratedPaths.has(file)) {
      toleratedPaths.add(file)
      process.emitWarning(
        `dsh-mobile: 跳过收紧 ${file}（${code}，当前进程不是属主）——`
        + '多 uid 共用账号目录时属预期，文件模式由写方决定',
      )
    }
    return
  }
  if (process.platform !== 'win32') return
  const userSid = await currentWindowsUserSid()
  await execFile('icacls.exe', [
    file,
    '/inheritance:r',
    '/grant:r',
    `*${userSid}:(F)`,
    '*S-1-5-18:(F)',
    '*S-1-5-32-544:(F)',
    '/remove:g',
    '*S-1-1-0',
    '*S-1-5-11',
    '*S-1-5-32-545',
  ], { encoding: 'utf8', windowsHide: true })
}
