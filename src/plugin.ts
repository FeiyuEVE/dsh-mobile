import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm/message'
// Side-effect type import: activates dsh-commands' Context augmentation so
// `ctx.commands` and its handler types resolve without a runtime dependency.
import type {} from '@deepseek-ai/dsh-commands'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { createRequire } from 'node:module'
import { X509Certificate } from 'node:crypto'
import { copyFile, lstat, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseControlFile, parseGatewayConfig, type PluginConfig, type ResolvedGatewayConfig } from './config.js'
import { assertSupportedDshVersion } from './compatibility.js'
import { MOBILE_CUSTOMIZATION_GUIDE } from './mobile-guide.js'
import {
  FollowingMobileAccessRuntime,
  JsonMobileAccessControlStore,
  MobileAccessGatewayController,
  type MobileAccessRuntime,
} from './control.js'
import { MobileAccessGateway } from './gateway.js'
import { createMobileAccessService, type MobileAccessService } from './extensions.js'
import { listComputerImages, readComputerImage } from './computer-images.js'
import {
  HttpError,
  LOCAL_ADMIN_PREFIX,
  assertLocalAdminTrust,
  parseRequestTarget,
  readJsonObject,
  sendFailure,
  sendJson,
} from './http-security.js'
import { JsonDeviceStore } from './storage.js'
import { FunnelController, funnelExecutable } from './funnel.js'
import { CpolarController } from './cpolar.js'
import { CpolarComponentManager, type CpolarComponentStatus } from './cpolar-component.js'
import { configuredRemoteProvider, JsonRemoteProviderStore, type RemoteProvider } from './remote.js'
import { parseAuthority, parseCidr } from './network.js'
import {
  materializeManagedSetup,
  parseManagedSetup,
  selectLanNetwork,
  type ManagedSetup,
} from './managed-setup.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-mobile'

/** The stock WebServer serves the control card; commands exposes /mobile to the DSH agent. */
export const inject = ['webServer', 'commands']

function installedDshVersion(): unknown {
  const manifest = createRequire(import.meta.url)('@deepseek-ai/dsh-host-webserver/package.json') as unknown
  if (manifest === null || typeof manifest !== 'object') return undefined
  return (manifest as { readonly version?: unknown }).version
}

function mapAdminError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EADDRNOTAVAIL') return new HttpError(409, 'network_address_changed')
  if (code === 'EADDRINUSE') return new HttpError(409, 'listen_port_in_use')
  if (error instanceof Error && error.message.startsWith('saved LAN interface ')) {
    return new HttpError(409, 'network_interface_unavailable')
  }
  if (error instanceof Error && error.message === 'cpolar_authtoken_invalid') {
    return new HttpError(400, 'cpolar_authtoken_invalid')
  }
  if (error instanceof Error && error.message.startsWith('cpolar_')) {
    return new HttpError(409, error.message)
  }
  return new HttpError(500, 'internal_error')
}

const SETUP_KEYS = new Set([
  'version', 'publicOrigin', 'listenHost', 'listenPort', 'upstreamOrigin',
  'publicAuthorities', 'allowedCidrs', 'instanceId', 'pairingCaFile', 'tls',
])

type LoadedSetup = {
  readonly kind: 'fixed'
  readonly config: PluginConfig
} | {
  readonly kind: 'managed'
  readonly config: PluginConfig
  readonly setup: ManagedSetup
}

function withoutSetupKeys(config: PluginConfig): PluginConfig {
  const merged = { ...config } as Record<string, unknown>
  for (const key of SETUP_KEYS) if (key !== 'version') delete merged[key]
  return merged as unknown as PluginConfig
}

async function loadSetup(config: PluginConfig): Promise<LoadedSetup> {
  if (config.setupFile === undefined) return { kind: 'fixed', config }
  if (!isAbsolute(config.setupFile)) throw new Error('setupFile must be an absolute file path')
  let source: string
  try {
    source = await readFile(resolve(config.setupFile), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'fixed', config }
    throw error
  }
  let parsed: unknown
  try { parsed = JSON.parse(source) as unknown }
  catch (error) { throw new Error('mobile setup file is not valid JSON', { cause: error }) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('mobile setup file must be an object')
  }
  const record = parsed as Record<string, unknown>
  if (record.version === 2) {
    return { kind: 'managed', config: withoutSetupKeys(config), setup: parseManagedSetup(record) }
  }
  if (record.version !== 1 || Reflect.ownKeys(record).some(key => typeof key !== 'string' || !SETUP_KEYS.has(key))) {
    throw new Error('mobile setup file has an unsupported format')
  }
  const { version: _version, ...setup } = record
  return {
    kind: 'fixed',
    config: { ...withoutSetupKeys(config), ...setup } as unknown as PluginConfig,
  }
}

function loopbackTemplate(loaded: LoadedSetup): ResolvedGatewayConfig {
  const base = withoutSetupKeys(loaded.config)
  return parseGatewayConfig({
    ...base,
    ...(loaded.kind === 'managed'
      ? { upstreamOrigin: loaded.setup.upstreamOrigin }
      : loaded.config.upstreamOrigin === undefined ? {} : { upstreamOrigin: loaded.config.upstreamOrigin }),
    listenHost: '127.0.0.1',
    listenPort: 0,
    publicAuthorities: ['127.0.0.1'],
    allowedCidrs: ['127.0.0.0/8'],
    tls: { mode: 'disabled' },
  })
}

async function stableInstanceId(loaded: LoadedSetup, template: ResolvedGatewayConfig): Promise<string> {
  if (loaded.kind !== 'managed') return loaded.config.instanceId ?? template.instanceId
  const certificate = new X509Certificate(await readFile(loaded.setup.tls.caCertFile))
  return certificate.fingerprint256.replaceAll(':', '').toLowerCase()
}

export function remoteGatewayConfig(
  template: ResolvedGatewayConfig,
  publicOrigin: string,
  stateFile: string,
  instanceId: string,
  listenPort = 0,
): ResolvedGatewayConfig {
  const origin = new URL(publicOrigin)
  if (origin.protocol !== 'https:' || origin.username !== '' || origin.password !== ''
    || origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') {
    throw new Error('remote public origin must be an HTTPS origin')
  }
  // The gateway listens on an ephemeral loopback port behind Funnel, while the
  // public authority is HTTPS on 443. Keep that external port explicit so the
  // trust policy never substitutes the private listener port into QR URLs.
  const publicAuthority = origin.port === '' ? `${origin.hostname}:443` : origin.host
  const { pairingCaFile: _pairingCaFile, ...shared } = template
  return Object.freeze({
    ...shared,
    listenHost: '127.0.0.1',
    listenPort,
    authorities: Object.freeze([parseAuthority(publicAuthority)]),
    allowedCidrs: Object.freeze([parseCidr('127.0.0.0/8')]),
    stateFile,
    instanceId,
    tls: Object.freeze({ mode: 'disabled' }),
    publicTls: true,
    discovery: false,
  })
}

interface RemoteStatus {
  readonly enabled: boolean
  readonly state: string
  readonly origin?: string
  readonly loginUrl?: string
  readonly setupUrl?: string
  readonly errorCode?: string
}

function remoteControlPayload(
  provider: RemoteProvider,
  status: RemoteStatus,
  gateway: MobileAccessGateway | undefined,
  providerStatuses: Readonly<Record<RemoteProvider, RemoteStatus>>,
  cpolarComponent: CpolarComponentStatus,
): Record<string, unknown> {
  return {
    provider,
    running: status.enabled,
    state: status.state,
    ...(status.origin === undefined ? {} : { origin: status.origin }),
    ...(status.loginUrl === undefined ? {} : { loginUrl: status.loginUrl }),
    ...(status.setupUrl === undefined ? {} : { setupUrl: status.setupUrl }),
    ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
    ...(gateway === undefined ? {} : { extensions: gateway.extensionStatus() }),
    providers: {
      tailscale: { bundled: true, running: providerStatuses.tailscale.enabled, state: providerStatuses.tailscale.state },
      cpolar: {
        bundled: false,
        running: providerStatuses.cpolar.enabled,
        state: providerStatuses.cpolar.state,
        component: cpolarComponent,
      },
    },
  }
}

/** Mount the resident control route and its optional authenticated LAN gateway. */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  assertSupportedDshVersion(installedDshVersion())
  const loaded = await loadSetup(config)
  const mobileAccess: MobileAccessService = createMobileAccessService(ctx)
  const template = loopbackTemplate(loaded)
  const instanceId = await stableInstanceId(loaded, template)
  const stateDirectory = dirname(template.stateFile)
  const remoteDirectory = join(stateDirectory, 'remote')
  const remoteProviderStore = new JsonRemoteProviderStore(
    join(remoteDirectory, 'provider.json'),
    configuredRemoteProvider(process.env),
  )
  let remoteProvider = (await remoteProviderStore.load()).provider
  const cpolarComponent = new CpolarComponentManager({ stateDirectory })
  await cpolarComponent.initialize()
  const unregisterBuiltin = mobileAccess.registerExtension({
    schemaVersion: 1,
    id: 'computer-images',
    name: 'Computer images',
    version: '1.0.0',
    description: 'Authenticated computer-side image browser',
    routes: [
      {
        method: 'GET', path: 'list',
        async handle(request) {
          return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(await listComputerImages(request.query.get('path'))) }
        },
      },
      {
        method: 'GET', path: 'image',
        async handle(request) {
          const image = await readComputerImage(request.query.get('path'))
          return { status: 200, contentType: image.contentType, headers: { 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(image.name)}` }, body: image.body }
        },
      },
    ],
  })
  let lanGateway: MobileAccessGateway | undefined
  const startGateway = async (candidateConfig: PluginConfig): Promise<MobileAccessRuntime> => {
    const resolved = parseGatewayConfig(candidateConfig)
    const candidate = new MobileAccessGateway(
      resolved,
      new JsonDeviceStore(resolved.stateFile, resolved.maxDevices),
      mobileAccess,
    )
    await candidate.start()
    lanGateway = candidate
    return {
      close: async () => {
        if (lanGateway === candidate) lanGateway = undefined
        await candidate.close()
      },
    }
  }
  const startRuntime = async (): Promise<MobileAccessRuntime> => {
    if (loaded.kind === 'fixed') return startGateway(loaded.config)
    const following = new FollowingMobileAccessRuntime(async () => {
      const network = selectLanNetwork(undefined, loaded.setup.networkInterface)
      return {
        key: `${network.name}\0${network.address}\0${network.cidr}`,
        start: async () => startGateway({
          ...loaded.config,
          ...await materializeManagedSetup(loaded.setup),
        }),
      }
    }, (error) => {
      process.emitWarning(`DSH Mobile could not follow the current LAN address: ${error instanceof Error ? error.message : String(error)}`, {
        code: 'DSH_MOBILE_NETWORK_REFRESH',
      })
    })
    await following.initialize(2_000)
    return following
  }
  const lanController = new MobileAccessGatewayController(
    new JsonMobileAccessControlStore(parseControlFile(config.controlFile), config.initiallyEnabled),
    startRuntime,
  )
  const remoteDeviceFile = join(remoteDirectory, 'devices.json')
  const legacyCpolarDeviceFile = join(remoteDirectory, 'cpolar', 'devices.json')
  if (remoteProvider === 'cpolar') {
    try {
      await lstat(remoteDeviceFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try { await copyFile(legacyCpolarDeviceFile, remoteDeviceFile) } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code !== 'ENOENT') throw copyError
      }
    }
  }
  const createRemoteGateway = async (publicOrigin: string, listenPort = 0): Promise<MobileAccessGateway> => {
      const resolved = remoteGatewayConfig(
        template,
        publicOrigin,
        remoteDeviceFile,
        instanceId,
        listenPort,
      )
      const candidate = new MobileAccessGateway(
        resolved,
        new JsonDeviceStore(resolved.stateFile, resolved.maxDevices),
        mobileAccess,
      )
      await candidate.start()
      return candidate
  }
  const tailscaleStore = new JsonMobileAccessControlStore(join(remoteDirectory, 'control.json'), false)
  const cpolarStore = new JsonMobileAccessControlStore(join(remoteDirectory, 'cpolar', 'control.json'), false)
  const remoteControllers = {
    tailscale: new FunnelController({
      store: tailscaleStore,
      executable: funnelExecutable(import.meta.url),
      stateDirectory: join(remoteDirectory, 'tailscale'),
      hostname: `dsh-${instanceId.slice(0, 12)}`,
      createGateway: createRemoteGateway,
    }),
    cpolar: new CpolarController({
      store: cpolarStore,
      executable: cpolarComponent.executable,
      configFile: cpolarComponent.configFile,
      region: 'cn',
      createGateway: createRemoteGateway,
    }),
  }
  const remoteController = () => remoteControllers[remoteProvider]
  const remotePayload = (): Record<string, unknown> => remoteControlPayload(
    remoteProvider,
    remoteController().status(),
    remoteController().gateway(),
    {
      tailscale: remoteControllers.tailscale.status(),
      cpolar: remoteControllers.cpolar.status(),
    },
    cpolarComponent.status(),
  )
  const selectRemoteProvider = async (provider: RemoteProvider): Promise<void> => {
    if (provider === remoteProvider) return
    const previousProvider = remoteProvider
    const previous = remoteControllers[previousProvider]
    const restore = previous.status().enabled
    if (restore) await previous.setEnabled(false)
    try {
      await remoteProviderStore.save({ version: 1, provider })
      remoteProvider = provider
    } catch (error) {
      if (restore) await previous.setEnabled(true)
      throw error
    }
  }
  const lanPayload = (): Record<string, unknown> => ({
    running: lanController.isRunning(),
    origin: lanGateway?.address().origin,
    ...(lanGateway === undefined ? {} : { extensions: lanGateway.extensionStatus() }),
  })

  const adminRoute: WebRoute = {
    kind: 'prefix',
    path: LOCAL_ADMIN_PREFIX,
    handler: async (request, response) => {
      try {
        const target = parseRequestTarget(request.url)
        assertLocalAdminTrust(request, request.method === 'POST')
        if (target.search !== '') throw new HttpError(400, 'bad_request')
        const lanControl = target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/control`
          || target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/lan/control`
        if (request.method === 'GET' && lanControl) {
          sendJson(response, 200, lanPayload(), false)
          return
        }
        if (request.method === 'POST' && lanControl) {
          const body = await readJsonObject(request, 4096)
          if (typeof body.running !== 'boolean') throw new HttpError(400, 'bad_request')
          await lanController.setRunning(body.running)
          sendJson(response, 200, lanPayload(), false)
          return
        }
        if (request.method === 'GET' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/control`) {
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/provider`) {
          const body = await readJsonObject(request, 4096)
          if (body.provider !== 'tailscale' && body.provider !== 'cpolar') throw new HttpError(400, 'bad_request')
          await selectRemoteProvider(body.provider)
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/cpolar/component/install`) {
          const body = await readJsonObject(request, 4096)
          if (body.confirm !== true) throw new HttpError(400, 'bad_request')
          await cpolarComponent.install()
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/cpolar/configure`) {
          const body = await readJsonObject(request, 4096)
          await cpolarComponent.configure(body.authtoken)
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/cpolar/component/purge`) {
          const body = await readJsonObject(request, 4096)
          if (body.confirm !== true) throw new HttpError(400, 'bad_request')
          await remoteControllers.cpolar.setEnabled(false)
          await cpolarComponent.purge()
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/control`) {
          const body = await readJsonObject(request, 4096)
          if (typeof body.running !== 'boolean') throw new HttpError(400, 'bad_request')
          await remoteController().setEnabled(body.running)
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/reconnect`) {
          await readJsonObject(request, 4096)
          await remoteController().reconnect()
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/reset`) {
          const body = await readJsonObject(request, 4096)
          if (body.confirm !== true) throw new HttpError(400, 'bad_request')
          await remoteController().reset()
          await rm(remoteDeviceFile, { force: true })
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (target.decodedPathname.startsWith(`${LOCAL_ADMIN_PREFIX}/remote/`)) {
          const active = remoteController().gateway()
          if (active === undefined) throw new HttpError(409, 'gateway_stopped')
          await active.localAdminRoute(`${LOCAL_ADMIN_PREFIX}/remote`).handler(request, response)
          return
        }
        if (target.decodedPathname.startsWith(`${LOCAL_ADMIN_PREFIX}/lan/`)) {
          const active = lanGateway
          if (active === undefined) throw new HttpError(409, 'gateway_stopped')
          await active.localAdminRoute(`${LOCAL_ADMIN_PREFIX}/lan`).handler(request, response)
          return
        }
        const active = lanGateway
        if (active === undefined) throw new HttpError(409, 'gateway_stopped')
        await active.localAdminRoute().handler(request, response)
      } catch (error) {
        const mapped = mapAdminError(error)
        if (response.headersSent) response.destroy()
        else sendFailure(response, mapped.status, mapped.code, false)
      }
    },
  }

  await ctx.effect(async () => {
    const unregister = ctx.webServer.register(adminRoute)
    const disposeMobileCommand = ctx.commands.register({
      name: 'mobile',
      description: '按需求修改 DSH Mobile 的手机端界面或添加电脑端能力',
      input: { hint: '<要做什么>' },
      handler: ({ agent, rawInput }) => {
        const task = rawInput.trim()
        if (task === '') return { kind: 'error', text: '请带上需求，例如：/mobile 把手机端改成深色主题' }
        // A plugin-source message renders as a collapsed context-injection row
        // (label "dsh-mobile", one-line notice summary) instead of a user bubble,
        // while steering still wakes the agent with the full guide as input.
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: `${MOBILE_CUSTOMIZATION_GUIDE}\n\n用户需求：${task}` }],
          source: {
            kind: 'plugin',
            plugin: 'dsh-mobile',
            form: 'notice',
            summary: boundContextSummary(`/mobile ${task}`),
          },
        }))
        return { kind: 'success', text: '已把需求交给 DSH 处理，改动会在手机端几秒内生效。' }
      },
    })
    try {
      await mobileAccess.startLocal(template.extensionsDir, ctx)
      await lanController.initialize()
      if (remoteProvider === 'tailscale') await cpolarStore.save({ version: 1, enabled: false })
      else await tailscaleStore.save({ version: 1, enabled: false })
      await remoteControllers.tailscale.initialize()
      await remoteControllers.cpolar.initialize()
    } catch (error) {
      unregister()
      disposeMobileCommand()
      await Promise.all([remoteControllers.tailscale.close(), remoteControllers.cpolar.close()])
      await lanController.close()
      await mobileAccess.stopLocal()
      unregisterBuiltin()
      throw error
    }
    return async () => {
      unregister()
      disposeMobileCommand()
      await Promise.all([remoteControllers.tailscale.close(), remoteControllers.cpolar.close()])
      await lanController.close()
      await mobileAccess.stopLocal()
      unregisterBuiltin()
    }
  }, 'dsh-mobile: independent LAN and selectable remote access with /mobile command')
}
