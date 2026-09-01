import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const arguments_ = process.argv.slice(2)
const contractOnly = arguments_.includes('--contract-only')
const unknownOptions = arguments_.filter(value => value.startsWith('--') && value !== '--contract-only')
if (unknownOptions.length > 0) throw new Error(`unknown option: ${unknownOptions[0]}`)
const sourceArguments = arguments_.filter(value => !value.startsWith('--'))
if (sourceArguments.length > 1) throw new Error('pass exactly one DeepSeek Harness source directory')
const sourceRoot = resolve(sourceArguments[0] ?? process.env.DSH_SOURCE_ROOT ?? '')
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

async function optionalJson(path) {
  const source = await optionalText(path)
  return source === undefined ? undefined : JSON.parse(source)
}

const plugin = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const supported = plugin.peerDependencies['@deepseek-ai/dsh-host-webserver'].split('||').map(value => value.trim())
const root = await json('package.json')
const declaredSupported = supported.includes(root.version)
if (!declaredSupported && !contractOnly) {
  throw new Error(`DSH ${root.version} is not in the verified set: ${supported.join(', ')}`)
}

const runtimeManifest = await optionalJson('packages/client/runtime/package.json')
const webManifest = await optionalJson('packages/client/web/package.json')
const clientArchitecture = runtimeManifest !== undefined ? 'runtime-v1' : webManifest !== undefined ? 'renderer-v2' : undefined
if (clientArchitecture === undefined) {
  throw new Error('DSH exposes neither the supported runtime-v1 nor renderer-v2 client architecture')
}

const packages = [
  'packages/host/webserver/package.json',
  'packages/client/connection/package.json',
  'packages/client/ui-theme/package.json',
  'packages/client/ui-layout/package.json',
  'packages/client/ui-sidebar/package.json',
  'packages/client/ui-conversation/package.json',
  'packages/client/ui-input-trigger/package.json',
  'packages/client/ui-settings/package.json',
  'packages/client/ui-user-questions/package.json',
  ...(clientArchitecture === 'runtime-v1'
    ? ['packages/client/runtime/package.json']
    : [
        'packages/client/web/package.json',
        'packages/client/locale/package.json',
        'packages/client/ui-renderer/package.json',
        'packages/client/ui-session/package.json',
      ]),
]
for (const path of packages) {
  const manifest = await json(path)
  if (manifest.version !== root.version) throw new Error(`${path} version ${manifest.version} does not match DSH ${root.version}`)
}

const layout = await json('packages/client/ui-layout/package.json')
const layoutInject = layout.dsh?.client?.inject
const layoutProfiles = [
  ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
  [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-session',
    '@deepseek-ai/dsh-client-ui-theme',
  ],
]
if (!Array.isArray(layoutInject)
  || !layoutProfiles.some(profile => profile.every(dependency => layoutInject.includes(dependency)))) {
  throw new Error(`DSH layout exposes an unsupported dependency profile: ${JSON.stringify(layoutInject)}`)
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

const composer = await text('packages/client/ui-conversation/src/client/skeleton/InputBar.tsx')
for (const marker of ['data-composer-card', 'data-input-scroll', 'aria-haspopup="listbox"']) {
  if (!composer.includes(marker)) throw new Error(`DSH composer command contract changed: missing ${marker}`)
}
const triggerMenu = await text('packages/client/ui-input-trigger/src/client/MenuView.tsx')
if (!triggerMenu.includes('data-trigger-menu=""')) {
  throw new Error('DSH command menu no longer exposes data-trigger-menu')
}

const connectionSource = await text('packages/client/connection/src/client/index.ts')
if (!connectionSource.includes('readonly isLoopback: boolean')) {
  throw new Error('DSH connection trust contract changed: missing readonly isLoopback')
}
const locationTrust = 'pageLocation === undefined || isLoopbackHostname(pageLocation.hostname)'
if (!connectionSource.includes(locationTrust)) {
  throw new Error(`DSH connection trust contract changed: missing ${locationTrust}`)
}
if (clientArchitecture === 'renderer-v2' && !connectionSource.includes('transport?.ownsHost === true')) {
  throw new Error('DSH renderer-v2 connection no longer recognizes a Host-owning transport')
}

const settingsSource = await text('packages/client/ui-settings/src/client/index.ts')
if (!settingsSource.includes("connection.isLoopback ? 'host' : 'memory'")
  && !settingsSource.includes("ctx.remote.$host.isLoopback ? 'host' : 'memory'")) {
  throw new Error('DSH settings trust contract changed')
}

const sidebarSource = await text('packages/client/ui-sidebar/src/client/SidebarRoot.tsx')
if (!sidebarSource.includes('css.fallbackBrandName')) {
  throw new Error('DSH sidebar fallback brand changed: missing css.fallbackBrandName')
}
const localeEnglish = await optionalText('packages/client/locale/src/locales/en.ts')
if (!sidebarSource.includes('DSH Local Build') && !localeEnglish?.includes("'brand.localBuild': 'DSH Local Build'")) {
  throw new Error('DSH sidebar fallback brand changed: missing DSH Local Build')
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

process.stdout.write(
  declaredSupported
    ? `DSH compatibility ok: ${root.version} (${clientArchitecture})\n`
    : `DSH frontend contract recognized: ${root.version} (${clientArchitecture}; not yet declared supported)\n`,
)
