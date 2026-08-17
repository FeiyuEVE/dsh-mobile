#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  ensureManagedCa,
  preferredLanInterfaceNames,
  refreshManagedServerCertificate,
  selectLanNetwork,
  type ManagedSetup,
} from './managed-setup.js'

interface SetupOptions {
  readonly address?: string
  readonly port: number
  readonly dshPort: number
  readonly configureFirewall: boolean
}

const execFile = promisify(execFileCallback)
const FIREWALL_TCP_RULE = 'DSH Mobile HTTPS'
const FIREWALL_UDP_RULE = 'DSH Mobile Discovery'

function parseOptions(args: readonly string[]): SetupOptions {
  let address: string | undefined
  let port = 3443
  let dshPort = 3080
  let configureFirewall = true
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    const value = args[index + 1]
    if (name === '--address' && value !== undefined) {
      address = value
      index += 1
      continue
    }
    if (name === '--port' && value !== undefined) {
      port = Number(value)
      index += 1
      continue
    }
    if (name === '--dsh-port' && value !== undefined) {
      dshPort = Number(value)
      index += 1
      continue
    }
    if (name === '--no-firewall') {
      configureFirewall = false
      continue
    }
    throw new Error(`unknown setup option: ${name ?? ''}`)
  }
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be from 1024 through 65535')
  if (!Number.isSafeInteger(dshPort) || dshPort < 1024 || dshPort > 65535) throw new Error('--dsh-port must be from 1024 through 65535')
  return { ...(address === undefined ? {} : { address }), port, dshPort, configureFirewall }
}

function dshHome(): string {
  return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
}

async function runElevatedPowerShell(script: string): Promise<void> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const launch = [
    "$ErrorActionPreference = 'Stop'; $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru",
    `  -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}')`,
    '; exit $process.ExitCode',
  ].join(' ')
  await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launch], { windowsHide: true })
}

async function configureWindowsFirewall(port: number): Promise<void> {
  if (process.platform !== 'win32') return
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Get-NetFirewallRule -DisplayName '${FIREWALL_TCP_RULE}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
    `Get-NetFirewallRule -DisplayName '${FIREWALL_UDP_RULE}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
    `New-NetFirewallRule -DisplayName '${FIREWALL_TCP_RULE}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${String(port)} -RemoteAddress LocalSubnet -Profile Any | Out-Null`,
    `New-NetFirewallRule -DisplayName '${FIREWALL_UDP_RULE}' -Direction Inbound -Action Allow -Protocol UDP -LocalPort ${String(port)} -RemoteAddress LocalSubnet -Profile Any | Out-Null`,
  ].join('; ')
  console.log('Windows will request administrator approval for two LAN-only firewall rules.')
  await runElevatedPowerShell(script)
}

async function removeWindowsFirewall(): Promise<void> {
  if (process.platform !== 'win32') return
  await runElevatedPowerShell([
    "$ErrorActionPreference = 'Stop'",
    `Get-NetFirewallRule -DisplayName '${FIREWALL_TCP_RULE}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
    `Get-NetFirewallRule -DisplayName '${FIREWALL_UDP_RULE}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
  ].join('; '))
}

async function setup(args: readonly string[]): Promise<void> {
  const options = parseOptions(args)
  const preferredInterfaces = options.address === undefined ? await preferredLanInterfaceNames() : []
  const network = selectLanNetwork(options.address, undefined, undefined, preferredInterfaces)
  const home = dshHome()
  const directory = join(home, 'mobile-access')
  const tls = join(directory, 'tls')
  await mkdir(tls, { recursive: true, mode: 0o700 })

  const legacyCertFile = join(tls, 'cert.pem')
  const legacyKeyFile = join(tls, 'key.pem')
  const certFile = join(tls, 'server-cert.pem')
  const keyFile = join(tls, 'server-key.pem')
  const caCertFile = join(tls, 'ca.pem')
  const caKeyFile = join(tls, 'ca-key.pem')
  const androidCertificate = join(tls, 'dsh-mobile-ca.cer')
  const managedTls: ManagedSetup['tls'] = {
    mode: 'managed',
    caCertFile,
    caKeyFile,
    certFile,
    keyFile,
  }
  const ca = await ensureManagedCa(managedTls, { certFile: legacyCertFile, keyFile: legacyKeyFile })
  const managedSetup: ManagedSetup = {
    version: 2,
    networkInterface: network.name,
    listenPort: options.port,
    upstreamOrigin: `http://127.0.0.1:${String(options.dshPort)}`,
    tls: managedTls,
  }
  await refreshManagedServerCertificate(managedSetup, network.address)
  await writeFile(androidCertificate, ca.raw, { mode: 0o600 })
  await Promise.all([
    chmod(caCertFile, 0o600),
    chmod(caKeyFile, 0o600),
    chmod(certFile, 0o600),
    chmod(keyFile, 0o600),
    chmod(androidCertificate, 0o600),
  ])
  if (options.configureFirewall) await configureWindowsFirewall(options.port)

  const customCss = join(directory, 'mobile.css')
  try {
    await readFile(customCss)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeFile(customCss, [
      '/* Safe mobile overrides. DSH Mobile applies saved changes on the phone automatically. */',
      ':root {',
      '  --dsh-mobile-accent: #2563eb;',
      '  --dsh-mobile-font-scale: 1;',
      '  --dsh-mobile-radius: 14px;',
      '}',
      '',
    ].join('\n'), { mode: 0o600 })
  }

  const customScript = join(directory, 'mobile.js')
  try {
    await readFile(customScript)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeFile(customScript, [
      '/* Mount mobile-only Web features here. Saved changes are applied automatically. */',
      'window.dshMobile.register(({ root }) => {',
      '  root.replaceChildren()',
      '  return () => root.replaceChildren()',
      '})',
      '',
    ].join('\n'), { mode: 0o600 })
  }

  const origin = `https://${network.address}:${String(options.port)}`
  await Promise.all([
    writeFile(join(directory, 'setup.json'), `${JSON.stringify({
      ...managedSetup,
      tls: Object.fromEntries(Object.entries(managedSetup.tls)
        .map(([key, value]) => [key, typeof value === 'string' ? value.replaceAll('\\', '/') : value])),
    }, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(directory, 'control.json'), '{"version":1,"enabled":true}\n', { mode: 0o600 }),
  ])

  console.log(`DSH Mobile follows ${network.name} and is currently configured for ${origin}`)
  console.log(`Install this CA certificate on Android once: ${androidCertificate}`)
  console.log(`Ask DSH to customize the mobile Web UI and features in: ${customCss} and ${customScript}`)
  console.log('Start DSH with: dsh --profile web')
  console.log('Then open the Mobile card in the lower-left corner and create a pairing key.')
}

async function purge(args: readonly string[]): Promise<void> {
  if (args.length !== 1 || args[0] !== '--yes') throw new Error('purge requires --yes')
  const home = dshHome()
  await rm(join(home, 'mobile-access'), { recursive: true, force: true })
  await removeWindowsFirewall()
  console.log('Removed DSH Mobile certificates, devices, preferences, and custom Web files.')
}

function help(): void {
  console.log([
    'dsh-mobile setup [--address 192.168.x.x] [--port 3443] [--dsh-port 3080] [--no-firewall]',
    'dsh-mobile purge --yes',
    '',
    'Run through the DSH profile:',
    '  dsh plugin --profile web exec dsh-mobile setup',
  ].join('\n'))
}

async function main(): Promise<void> {
  const [command = 'help', ...args] = process.argv.slice(2)
  if (command === 'setup') await setup(args)
  else if (command === 'purge') await purge(args)
  else if (command === 'help' || command === '--help' || command === '-h') help()
  else throw new Error(`unknown command: ${command}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
