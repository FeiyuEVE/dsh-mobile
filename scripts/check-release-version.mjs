import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function read(relativePath) {
  return readFile(resolve(root, relativePath), 'utf8')
}

function singleMatch(source, pattern, label) {
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1 || matches[0][1] === undefined) {
    throw new Error(`${label} must appear exactly once`)
  }
  return matches[0][1]
}

function positiveBuildNumber(value, label) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

async function main() {
  const manifest = JSON.parse(await read('package.json'))
  if (typeof manifest.version !== 'string') throw new Error('package.version must be a string')

  const packageVersion = manifest.version
  const android = await read('apps/mobile/android/app/build.gradle.kts')

  const androidVersion = singleMatch(android, /^\s*versionName\s*=\s*"([^"]+)"\s*$/gm, 'Android versionName')
  const androidBuild = positiveBuildNumber(
    singleMatch(android, /^\s*versionCode\s*=\s*(\d+)\s*$/gm, 'Android versionCode'),
    'Android versionCode',
  )
  if (androidVersion !== packageVersion) {
    throw new Error(`Android versionName ${JSON.stringify(androidVersion)} must equal package.version ${JSON.stringify(packageVersion)}`)
  }

  if (process.argv.includes('--tag-env')) {
    const expectedTag = `v${packageVersion}`
    const actualTag = process.env.GITHUB_REF_NAME
    if (actualTag !== expectedTag) {
      throw new Error(`GITHUB_REF_NAME ${JSON.stringify(actualTag)} must equal ${JSON.stringify(expectedTag)}`)
    }
    console.log(`release tag ok: ${actualTag}`)
  }

  console.log(`release versions ok: package=${packageVersion}, Android=${androidVersion} (${androidBuild})`)
}

main().catch((error) => {
  console.error(`release version check failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
