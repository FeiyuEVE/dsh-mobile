import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 测试工作目录统一放仓库根 `.tmp/`（已在 .gitignore），不写 `/tmp`。
 * 这是给整个 `tests/` 用的共享入口，避免每个文件各写一份。
 */
export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const TMP_ROOT = join(PROJECT_ROOT, '.tmp')

/**
 * 建一个唯一的项目内临时目录（`fs.mkdtemp` 的同类替身）。清理由调用方负责。
 * `fs.mkdtemp` 要求父目录存在，所以先确保 `.tmp/` 建好。
 */
export async function createTempDirectory(prefix: string): Promise<string> {
  await mkdir(TMP_ROOT, { recursive: true })
  return mkdtemp(join(TMP_ROOT, prefix))
}
