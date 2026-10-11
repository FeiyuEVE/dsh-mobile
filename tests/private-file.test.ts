import { execFile as execFileCallback } from 'node:child_process'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { restrictPrivateFile } from '../src/private-file.js'
import { createTempDirectory } from './tmp-root.js'

const execFile = promisify(execFileCallback)

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/** 测试工作目录落仓库根 `.tmp/`，不写 /tmp。 */
async function tempDirectory(prefix: string): Promise<string> {
  const directory = await createTempDirectory(prefix)
  temporaryDirectories.push(directory)
  return directory
}

describe('private file permissions', () => {
  it('keeps the file readable while removing inherited Windows access', async () => {
    const directory = await tempDirectory('dsh-mobile-private-')
    const file = join(directory, 'secret.json')
    await writeFile(file, '{"secret":true}\n')
    await restrictPrivateFile(file)
    await expect(readFile(file, 'utf8')).resolves.toContain('secret')

    if (process.platform === 'win32') {
      const { stdout } = await execFile('icacls.exe', [file], { encoding: 'utf8', windowsHide: true })
      expect(stdout).not.toContain('(I)')
      expect(stdout).not.toMatch(/Everyone|Authenticated Users|BUILTIN\\Users|CodexSandboxUsers/iu)
    } else {
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    }
  })
})
