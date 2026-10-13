/**
 * 内容热更（页面资源 + Dart 补丁）的**网关侧只读面**。
 *
 * 两条前缀，都挂在已有的账号会话鉴权之下（与 `/app/*` 分发包同一条通道）：
 *
 * | 前缀 | 谁在取 | 内容 |
 * |---|---|---|
 * | `APP_ASSETS_PREFIX` | App 的 Dart 侧 `RemoteAssets`（`lib/core/remote_assets.dart`） | `manifest.json` + 逻辑名文件树 |
 * | `CODE_PUSH_PREFIX` | **设备里的 libupdater**（经 App 的回环中继） | 设备端那两个端点 + 补丁字节 |
 *
 * ## 为什么补丁端点在网关里实现，而不是再起一个服务
 *
 * 设备端协议只有「两个端点 + 一个静态下载」，且**它是冻的**（编在引擎里，见
 * `shorebirdtech/updater` 的 `library/src/network.rs`：请求体是 `PatchCheckRequest`、
 * 应答是 `PatchCheckResponse`）。这份逻辑的权威实现是
 * `../dsh-mobile-flutter/.tmp/codepush/server/patch_server.py`（发布脚本 `publish_patch.py`
 * 写出的 `index.json` 就是它的输入），本文件是它在网关里的**同形移植**——两边必须逐条
 * 对齐，`tests/gateway.test.ts` 的「内容热更」组是哨兵。
 *
 * 换句话说：**这里不新增服务、不新增端口**，读的是发布脚本写下的同一份目录
 * （`codePushDir/index.json` + `codePushDir/*.bin`）。
 *
 * ## 三条硬约束（改这里前先读）
 *
 * 1. **路径一律先过白名单再拼**：目录名来自 HTTP，`..`/绝对路径/反斜杠都要挡；
 *    白名单正则与 App 侧 `remote_assets.dart` 的 `_safeNameRe` **逐字同源**——两边
 *    不一致会出现「发布出去的包自己带着被客户端静默跳过的条目」。
 * 2. **文件不存在 / 目录不存在都回 404，不回 500**：内容目录是**可选**的（没发布过
 *    就没有），App 侧的设计是「任何失败都回落内置」，把「还没发布」变成 5xx 只会
 *    让 App 的日志里多一堆吓人的错误。
 * 3. **`rolled_back_patch_numbers` 在「没有新补丁」时也要下发**：设备靠它卸载已装
 *    但被回滚的补丁；只回 `patch_available:false` 会让它继续从被回滚的补丁启动
 *    （上游 demo 的 v1 就踩了这个，别再踩）。
 */
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { AUTH_PREFIX, HttpError, readJsonObject, sendJson, setSecurityHeaders } from './http-security.js'

/** 页面资源前缀（App 侧常量 `kAppAssetsPrefix` 必须与它逐字一致）。 */
export const APP_ASSETS_PREFIX = `${AUTH_PREFIX}/app-assets`
/** Dart 补丁前缀（App 侧常量 `kCodePushPrefix` 必须与它逐字一致）。 */
export const CODE_PUSH_PREFIX = `${AUTH_PREFIX}/codepush`

/** 资源清单文件名（App 侧 `remote_assets.dart` 的 `manifestName`）。 */
export const ASSET_MANIFEST_NAME = 'manifest.json'
/** 补丁清单文件名（发布脚本 `publish_patch.py` 写出的就是它）。 */
export const CODE_PUSH_INDEX_NAME = 'index.json'

/** 逻辑名白名单：**与 App 侧 `remote_assets.dart` 的 `_safeNameRe` 同源**。 */
const SAFE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u
/** 补丁文件名白名单：单层文件名（`index.json` 里登记的就是 `patch-N.bin`）。 */
const SAFE_PATCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
/** 清单上限：远大于真实体积（2 MB），只用来挡住「拿它当上传口」。 */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
/** check 请求体上限（`PatchCheckRequest` 是几十字节的 JSON）。 */
const MAX_CHECK_BODY_BYTES = 64 * 1024

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
})

/** 内容根目录（两个都**允许不存在**：没发布过就是「没有热更内容」）。 */
export interface HotUpdateRoots {
  /** 页面资源目录（`manifest.json` + 逻辑名文件树）。 */
  readonly assetsDir: string
  /** 补丁目录（`index.json` + `*.bin`）。 */
  readonly codePushDir: string
}

/** 扩展名 → Content-Type；认不出的按二进制（补丁、未知静态资源都走这条）。 */
export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/** 逻辑名是否合法（与 App 侧同口径：长度、`..`、反斜杠、`//`、结尾斜杠）。 */
export function isSafeAssetName(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false
  if (name.includes('..') || name.includes('\\') || name.includes('//') || name.endsWith('/')) return false
  return SAFE_ASSET_NAME.test(name)
}

/** 补丁文件名是否合法（单层、有扩展名、长度受限）。 */
export function isSafePatchName(name: string): boolean {
  return SAFE_PATCH_NAME.test(name)
}

/**
 * 把逻辑名解析到根目录内的绝对路径。
 *
 * 白名单之外一律 404（不是 400）：调用方是设备/App，多给一种状态码只会多一种要
 * 处理的形状；**并且**再做一次 `resolve` 之后的前缀校验兜底（符号链接/边界情况）。
 */
export function resolveInside(root: string, name: string, safe: (value: string) => boolean): string {
  if (!safe(name)) throw new HttpError(404, 'not_found')
  const base = resolve(root)
  const full = resolve(base, name)
  if (full !== base && !full.startsWith(`${base}${sep}`)) throw new HttpError(404, 'not_found')
  return full
}

/** 读一个文件并回出去；不存在/不是普通文件 → 404。 */
export async function serveFile(
  response: ServerResponse,
  path: string,
  contentType: string,
  tls: boolean,
  headers: OutgoingHeaderPairs = {},
): Promise<void> {
  let size: number
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new HttpError(404, 'not_found')
    size = info.size
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(404, 'not_found')
  }
  setSecurityHeaders(response, tls)
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': size,
    'Cache-Control': 'no-store',
    ...headers,
  })
  await pipeline(createReadStream(path), response)
}

type OutgoingHeaderPairs = Readonly<Record<string, string>>

/** 读页面资源（`manifest.json` 与文件树同一套）。 */
export async function serveAsset(response: ServerResponse, roots: HotUpdateRoots, name: string, tls: boolean): Promise<void> {
  const path = resolveInside(roots.assetsDir, name, isSafeAssetName)
  await serveFile(response, path, contentTypeFor(name), tls)
}

/** 读补丁字节。 */
export async function servePatch(response: ServerResponse, roots: HotUpdateRoots, name: string, tls: boolean): Promise<void> {
  const path = resolveInside(roots.codePushDir, name, isSafePatchName)
  await serveFile(response, path, 'application/octet-stream', tls)
}

/** 读并解析补丁清单；缺失或坏掉都当空清单（**绝不 500**，见文件头第 2 条）。 */
export async function readCodePushIndex(dir: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(resolve(dir, CODE_PUSH_INDEX_NAME))
    if (raw.length > MAX_MANIFEST_BYTES) return { releases: {} }
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { releases: {} }
    return parsed as Record<string, unknown>
  } catch {
    return { releases: {} }
  }
}

/** 发布脚本写进 `index.json` 的一条补丁登记。 */
interface RegisteredPatch {
  readonly number: number
  readonly file: string
  readonly hash: string
  readonly signature?: string | null
  readonly rolled_back?: boolean
}

function registeredPatches(index: Record<string, unknown>, key: string): RegisteredPatch[] {
  const releases = index.releases
  if (typeof releases !== 'object' || releases === null || Array.isArray(releases)) return []
  const entry = (releases as Record<string, unknown>)[key]
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
  const patches = (entry as Record<string, unknown>).patches
  if (!Array.isArray(patches)) return []
  const out: RegisteredPatch[] = []
  for (const item of patches) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const number = Number(record.number)
    const file = record.file
    const hash = record.hash
    if (!Number.isInteger(number) || number <= 0) continue
    if (typeof file !== 'string' || !isSafePatchName(file)) continue
    if (typeof hash !== 'string' || hash === '') continue
    out.push({
      number,
      file,
      hash,
      signature: typeof record.signature === 'string' ? record.signature : null,
      rolled_back: record.rolled_back === true,
    })
  }
  return out
}

/**
 * 设备端 `POST .../check` 的应答体。
 *
 * 与 `patch_server.py::_handle_check` **逐条对齐**：
 * - 只挑「编号更大、没被回滚」里最大的那条；没有就 `patch_available:false`
 * - 回滚清单**无条件**带上（见文件头第 3 条）
 * - `download_url` 指向本网关的下载路由（设备端 updater 不额外带任何头，也不认
 *   相对地址；经 App 回环中继时它会被改写成 `127.0.0.1` 那个地址）
 */
export function codePushCheckResponse(
  index: Record<string, unknown>,
  body: Record<string, unknown>,
  downloadBase: string,
): Record<string, unknown> {
  const key = [body.release_version, body.platform, body.arch].map(value => (typeof value === 'string' ? value : '')).join('|')
  const current = Number.isInteger(body.current_patch_number) ? Number(body.current_patch_number) : 0
  const patches = registeredPatches(index, key)
  const response: Record<string, unknown> = { patch_available: false }
  const candidates = patches.filter(patch => patch.rolled_back !== true && patch.number > current).sort((a, b) => a.number - b.number)
  if (candidates.length > 0) {
    const newest = candidates[candidates.length - 1]!
    const patch: Record<string, unknown> = {
      number: newest.number,
      hash: newest.hash,
      download_url: `${downloadBase}/${encodeURIComponent(newest.file)}`,
    }
    if (newest.signature !== null && newest.signature !== undefined && newest.signature !== '') patch.hash_signature = newest.signature
    response.patch_available = true
    response.patch = patch
  }
  const rolledBack = patches.filter(patch => patch.rolled_back === true).map(patch => patch.number).sort((a, b) => a - b)
  if (rolledBack.length > 0) response.rolled_back_patch_numbers = rolledBack
  return response
}

/** 读 `PatchCheckRequest`（设备端 `ureq` 的 `send_json` 一定带 `application/json`）。 */
export function readCodePushCheckBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return readJsonObject(request, MAX_CHECK_BODY_BYTES)
}

/** 设备端的事件上报体（只记日志用，形状不进契约）。 */
export function readCodePushEventBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return readJsonObject(request, MAX_CHECK_BODY_BYTES)
}

/** 把应答发出去（补丁路由的 JSON 都走它，保证 CSP/不缓存头一致）。 */
export function sendCodePushJson(response: ServerResponse, status: number, value: unknown, tls: boolean): void {
  sendJson(response, status, value, tls)
}
