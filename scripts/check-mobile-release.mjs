import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  throw new Error(message)
}

async function read(relativePath, encoding) {
  return readFile(resolve(root, relativePath), encoding)
}

/**
 * Plugin-owned UI must follow DSH's locale and must never persist a locale
 * preference of its own. The Kotlin shell that used to keep one
 * (`dsh-mobile-control-locale`) was retired on 2026-10-11; this sentinel keeps
 * it from creeping back into the Web plugin through a future port.
 */
async function checkPluginLocale() {
  const sources = await Promise.all([
    read('src/client.ts', 'utf8'),
    read('src/mobile-layout.ts', 'utf8'),
    read('src/native-mobile.ts', 'utf8'),
  ])
  if (!sources.every(source => !source.includes('dsh-mobile-control-locale'))) {
    fail('Web plugin language must follow DSH and must not persist an independent locale preference')
  }
}

async function checkFunnelHost() {
  const [manifestSource, goModule, goSum, source, executable] = await Promise.all([
    read('package.json', 'utf8'),
    read('native/funnel-host/go.mod', 'utf8'),
    read('native/funnel-host/go.sum', 'utf8'),
    read('native/funnel-host/main.go', 'utf8'),
    read('bin/dsh-mobile-funnel-win32-x64.exe'),
  ])
  const manifest = JSON.parse(manifestSource)
  if (!manifest.files?.includes('bin/dsh-mobile-funnel-win32-x64.exe')) {
    fail('package files must include the Windows Funnel host')
  }
  if (!manifest.files?.includes('THIRD_PARTY_NOTICES.md')) fail('package files must include third-party notices')
  if (!/^go 1\.26\.6$/mu.test(goModule) || !/^require tailscale\.com v1\.102\.3$/mu.test(goModule)) {
    fail('Funnel host must pin Go 1.26.6 and Tailscale 1.102.3')
  }
  if (goSum.length === 0 || !source.includes('tailscale.com/tsnet')) fail('Funnel host source and module checksums are incomplete')
  if (executable.byteLength < 2 || executable.subarray(0, 2).toString('ascii') !== 'MZ') {
    fail('Funnel host must be a Windows executable built from the checked source')
  }
  if (executable.byteLength >= 40 * 1024 * 1024) fail('Funnel host must remain below 40 MiB')
}

async function main() {
  await Promise.all([
    checkPluginLocale(),
    checkFunnelHost(),
  ])
  console.log('mobile release assets ok: plugin locale policy, package files, and Funnel host')
}

main().catch((error) => {
  console.error(`mobile release check failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
