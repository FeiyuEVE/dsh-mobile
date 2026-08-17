import { X509Certificate } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ensureManagedCa,
  materializeManagedSetup,
  parseManagedSetup,
  selectLanNetwork,
  type ManagedSetup,
} from '../src/managed-setup.js'

function interfaceTable(address: string) {
  return {
    WLAN: [{
      address,
      netmask: '255.255.255.0',
      family: 'IPv4' as const,
      mac: '00:00:00:00:00:00',
      internal: false,
      cidr: `${address}/24`,
    }],
  }
}

async function fixture(): Promise<ManagedSetup> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-managed-'))
  return {
    version: 2,
    networkInterface: 'WLAN',
    listenPort: 3443,
    upstreamOrigin: 'http://127.0.0.1:3080',
    tls: {
      mode: 'managed',
      caCertFile: join(directory, 'ca.pem'),
      caKeyFile: join(directory, 'ca-key.pem'),
      certFile: join(directory, 'server.pem'),
      keyFile: join(directory, 'server-key.pem'),
    },
  }
}

describe('managed DHCP setup', () => {
  it('follows the saved interface when its address changes', () => {
    expect(selectLanNetwork(undefined, 'WLAN', interfaceTable('192.168.50.23'))).toEqual({
      name: 'WLAN',
      address: '192.168.50.23',
      cidr: '192.168.50.0/24',
    })
  })

  it('keeps one CA while signing a leaf for the current address', async () => {
    const setup = await fixture()
    const ca = await ensureManagedCa(setup.tls)
    const config = await materializeManagedSetup(setup, interfaceTable('192.168.50.23'))
    const leaf = new X509Certificate(await readFile(setup.tls.certFile, 'utf8'))

    expect(config).toMatchObject({
      publicOrigin: 'https://192.168.50.23:3443',
      listenHost: '192.168.50.23',
      allowedCidrs: ['192.168.50.0/24'],
      pairingCaFile: setup.tls.caCertFile,
    })
    expect(leaf.checkIP('192.168.50.23')).toBe('192.168.50.23')
    expect(leaf.verify(ca.publicKey)).toBe(true)
    expect(leaf.subject).not.toBe(leaf.issuer)

    await materializeManagedSetup(setup, interfaceTable('192.168.50.99'))
    const rotated = new X509Certificate(await readFile(setup.tls.certFile, 'utf8'))
    const persistedCa = new X509Certificate(await readFile(setup.tls.caCertFile, 'utf8'))
    expect(rotated.checkIP('192.168.50.99')).toBe('192.168.50.99')
    expect(rotated.verify(persistedCa.publicKey)).toBe(true)
    expect(persistedCa.fingerprint256).toBe(ca.fingerprint256)
  })

  it('rejects unknown durable fields before using paths', () => {
    expect(() => parseManagedSetup({
      version: 2,
      networkInterface: 'WLAN',
      listenPort: 3443,
      upstreamOrigin: 'http://127.0.0.1:3080',
      tls: {
        mode: 'managed',
        caCertFile: 'ca.pem',
        caKeyFile: 'ca-key.pem',
        certFile: 'server.pem',
        keyFile: 'server-key.pem',
      },
      unexpected: true,
    })).toThrow('unsupported format')
  })
})
