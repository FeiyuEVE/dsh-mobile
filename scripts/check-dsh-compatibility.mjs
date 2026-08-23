import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const sourceRoot = resolve(process.argv[2] ?? process.env.DSH_SOURCE_ROOT ?? '')
if (sourceRoot === resolve('')) throw new Error('pass a DeepSeek Harness source directory')

async function json(path) {
  return JSON.parse(await readFile(resolve(sourceRoot, path), 'utf8'))
}

async function text(path) {
  return readFile(resolve(sourceRoot, path), 'utf8')
}

async function optionalText(path) {
  try {
    return await text(path)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return undefined
    throw error
  }
}

const plugin = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const supported = plugin.peerDependencies['@deepseek-ai/dsh-host-webserver'].split('||').map(value => value.trim())
const root = await json('package.json')
if (!supported.includes(root.version)) {
  throw new Error(`DSH ${root.version} is not in the verified set: ${supported.join(', ')}`)
}

const packages = [
  'packages/host/webserver/package.json',
  'packages/client/runtime/package.json',
  'packages/client/ui-theme/package.json',
  'packages/client/ui-layout/package.json',
  'packages/client/ui-sidebar/package.json',
  'packages/client/ui-conversation/package.json',
  'packages/client/ui-settings/package.json',
  'packages/client/ui-user-questions/package.json',
]
for (const path of packages) {
  const manifest = await json(path)
  if (manifest.version !== root.version) throw new Error(`${path} version ${manifest.version} does not match DSH ${root.version}`)
}

const layout = await json('packages/client/ui-layout/package.json')
const layoutInject = layout.dsh?.client?.inject
for (const dependency of ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme']) {
  if (!Array.isArray(layoutInject) || !layoutInject.includes(dependency)) {
    throw new Error(`DSH layout no longer injects ${dependency}`)
  }
}

const layoutSource = await text('packages/client/ui-layout/src/client/index.ts')
for (const declaration of [
  "'sidebar': { kind: 'single', scope: 'root' }",
  "'conversation': { kind: 'single', scope: 'session-maybe' }",
  "'details': { kind: 'single', scope: 'session' }",
  "'shell.overlay': { kind: 'list', scope: 'root' }",
  "ctx.reflect.provide('layout'",
]) {
  if (!layoutSource.includes(declaration)) throw new Error(`DSH layout contract changed: missing ${declaration}`)
}

const conversation = await text('packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx')
if (!conversation.includes('data-conversation-scroll')) {
  throw new Error('DSH conversation no longer exposes data-conversation-scroll')
}

const questions = await text('packages/client/ui-user-questions/src/client/QuestionComposer.tsx')
const planReview = await text('packages/client/ui-user-questions/src/client/PlanReviewPanel.tsx')
for (const marker of ['data-question-key', 'data-question-scroll']) {
  if (!questions.includes(marker)) throw new Error(`DSH question UI contract changed: missing ${marker}`)
}
for (const marker of ['data-plan-review-key', 'data-plan-review-scroll']) {
  if (!planReview.includes(marker)) throw new Error(`DSH plan-review UI contract changed: missing ${marker}`)
}

const hostInjections = await optionalText('packages/host/webserver/src/injections.ts')
const legacyModules = await optionalText('packages/client/modules/src/index.ts')
if (!hostInjections?.includes('globalThis[${name}] = ${value}')
  && !legacyModules?.includes('window.__DSH_BOOT__ = ${json}')) {
  throw new Error('DSH boot manifest uses an unsupported global injection syntax')
}

process.stdout.write(`DSH compatibility ok: ${root.version}\n`)
