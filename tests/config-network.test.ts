import { join } from 'node:path'
import { TMP_ROOT } from './tmp-root.js'
import { describe, expect, it } from 'vitest'
import { Config, parseAccountFileMode, parseControlFile, parseGatewayConfig } from '../src/config.js'
import {
  addressAllowed,
  parseAuthority,
  parseCidr,
  RequestTrustPolicy,
  resolveAuthority,
} from '../src/network.js'

const stateFile = join(TMP_ROOT, 'dsh-mobile-access-config-test.json')
const controlFile = join(TMP_ROOT, 'dsh-mobile-access-control-test.json')

describe('gateway configuration', () => {
  it('keeps an additional TLS chain optional in the Loader schema', () => {
    const value = Config({
      stateFile,
      controlFile,
      initiallyEnabled: false,
      tls: {
        mode: 'provided',
        certFile: join(TMP_ROOT, 'server-cert.pem'),
        keyFile: join(TMP_ROOT, 'server-key.pem'),
      },
    })

    expect(value.tls?.caFile).toBeUndefined()
    const resolved = parseGatewayConfig(value)
    expect(resolved).toMatchObject({
      listenHost: '127.0.0.1',
      listenPort: 3443,
      tls: { mode: 'provided' },
    })
    expect(resolved.upstreamOrigin.origin).toBe('http://127.0.0.1:3080')
    expect(resolved.allowedCidrs).toHaveLength(2)
    expect(resolved.customCssFile).toBe(join(TMP_ROOT, 'mobile.css'))
    expect(resolved.customScriptFile).toBe(join(TMP_ROOT, 'mobile.js'))
  })

  it('默认账号目录 = stateFile 所在目录；配了 accountDir 就用它（三服统一鉴权）', () => {
    const tls = {
      mode: 'provided' as const,
      certFile: join(TMP_ROOT, 'server-cert.pem'),
      keyFile: join(TMP_ROOT, 'server-key.pem'),
    }
    const base = Config({ stateFile, controlFile, initiallyEnabled: false, tls })
    expect(parseGatewayConfig(base).accountDir).toBe(TMP_ROOT)

    const shared = join(TMP_ROOT, 'shared-mobile-access')
    const pointing = Config({ ...base, accountDir: shared })
    expect(parseGatewayConfig(pointing).accountDir).toBe(shared)
  })

  it('accountFileMode 白名单：默认 0600，只认「属主 rw + 可选共享组」，不许对 other 开口', () => {
    const tls = {
      mode: 'provided' as const,
      certFile: join(TMP_ROOT, 'server-cert.pem'),
      keyFile: join(TMP_ROOT, 'server-key.pem'),
    }
    const base = Config({ stateFile, controlFile, initiallyEnabled: false, tls })
    // 不配 = 单进程老行为。
    expect(parseGatewayConfig(base).accountFileMode).toBe(0o600)

    // 跨 uid 共用账号目录的唯一正当松绑方向：往共享组开 r/w。
    for (const allowed of [0o600, 0o620, 0o640, 0o660]) {
      expect(parseAccountFileMode(allowed)).toBe(allowed)
      expect(parseGatewayConfig({ ...base, accountFileMode: allowed }).accountFileMode).toBe(allowed)
    }

    // 逐类拒绝：十进制 640（把 0640 写错的常见形态）、对 other 可读、对 other 可写（= 谁都能签 token）、
    // 带执行位、比属主 rw 更紧（写方自己都读不回）、非整数、字符串、setuid 位。
    for (const rejected of [640, 0o644, 0o666, 0o755, 0o400, 0o6000, 640.5, '0o640', null, Number.NaN]) {
      expect(() => parseAccountFileMode(rejected)).toThrow(/accountFileMode/u)
    }
  })

  it('keeps durable device state required at the Loader boundary', () => {
    expect(() => Config()).toThrow(/stateFile missing required value/)
  })

  it('requires an absolute hidden control-state file', () => {
    expect(parseControlFile(controlFile)).toBe(controlFile)
    expect(() => parseControlFile('control.json')).toThrow(/controlFile must be an absolute file path/)
    expect(() => Config({
      stateFile,
      controlFile: undefined as never,
      initiallyEnabled: false,
    })).toThrow(/controlFile missing required value/)
    expect(() => Config({
      stateFile,
      controlFile,
      initiallyEnabled: undefined as never,
    })).toThrow(/initiallyEnabled missing required value/)
  })

  it('derives the listener port and sole authority from a public HTTPS origin', () => {
    const quick = Config({
      publicOrigin: 'https://192.168.50.23:3443',
      allowedCidrs: ['192.168.50.0/24'],
      stateFile,
      controlFile,
      initiallyEnabled: true,
      tls: {
        mode: 'provided',
        certFile: join(TMP_ROOT, 'quick-cert.pem'),
        keyFile: join(TMP_ROOT, 'quick-key.pem'),
      },
    })
    expect(quick.publicAuthorities).toBeUndefined()
    const resolved = parseGatewayConfig(quick)

    expect(resolved.listenHost).toBe('0.0.0.0')
    expect(resolved.listenPort).toBe(3443)
    expect(resolved.authorities).toEqual([{ hostname: '192.168.50.23', port: 3443 }])

    const defaultPort = parseGatewayConfig({
      publicOrigin: 'https://dsh.home.arpa/',
      allowedCidrs: ['192.168.50.0/24'],
      stateFile,
      tls: {
        mode: 'provided',
        certFile: join(TMP_ROOT, 'default-port-cert.pem'),
        keyFile: join(TMP_ROOT, 'default-port-key.pem'),
      },
    })
    expect(defaultPort.listenPort).toBe(443)
    expect(defaultPort.authorities).toEqual([{ hostname: 'dsh.home.arpa' }])
  })

  it.each([
    'http://192.168.50.23:3443',
    'https://user:password@192.168.50.23:3443',
    'https://192.168.50.23:3443/path',
    'https://192.168.50.23:3443/?query=value',
    'https://192.168.50.23:3443/#fragment',
    'https://0.0.0.0:3443',
  ])('rejects unsafe public origin %s', (publicOrigin) => {
    expect(() => parseGatewayConfig({
      publicOrigin,
      allowedCidrs: ['192.168.50.0/24'],
      stateFile,
      tls: {
        mode: 'provided',
        certFile: join(TMP_ROOT, 'invalid-origin-cert.pem'),
        keyFile: join(TMP_ROOT, 'invalid-origin-key.pem'),
      },
    })).toThrow(/publicOrigin/)
  })

  it('rejects ambiguous quick and advanced public network configuration', () => {
    const tls = {
      mode: 'provided' as const,
      certFile: join(TMP_ROOT, 'conflict-cert.pem'),
      keyFile: join(TMP_ROOT, 'conflict-key.pem'),
    }
    expect(() => parseGatewayConfig({
      publicOrigin: 'https://192.168.50.23:3443',
      listenPort: 3443,
      allowedCidrs: ['192.168.50.0/24'],
      stateFile,
      tls,
    })).toThrow(/publicOrigin cannot be combined with listenPort/)
    expect(() => parseGatewayConfig({
      publicOrigin: 'https://192.168.50.23:3443',
      publicAuthorities: ['192.168.50.23:3443'],
      allowedCidrs: ['192.168.50.0/24'],
      stateFile,
      tls,
    })).toThrow(/publicOrigin cannot be combined with publicAuthorities/)
    expect(() => parseGatewayConfig({
      publicOrigin: 'https://127.0.0.1:3443',
      listenHost: '127.0.0.1',
      stateFile,
      tls: { mode: 'disabled' },
    })).toThrow(/publicOrigin requires TLS/)
  })

  it('rejects sessions that could outlive their device credential', () => {
    expect(() => parseGatewayConfig({
      stateFile,
      tls: { mode: 'disabled' },
      deviceTtlMs: 60_000,
      sessionTtlMs: 60_001,
    })).toThrow(/sessionTtlMs must not exceed deviceTtlMs/)
  })

  it('accepts a loopback-only HTTP development listener', () => {
    const config = parseGatewayConfig({
      listenHost: '127.0.0.1',
      listenPort: 3443,
      upstreamOrigin: 'http://127.0.0.1:3080',
      publicAuthorities: ['127.0.0.1:3443'],
      allowedCidrs: ['127.0.0.0/8'],
      stateFile,
      tls: { mode: 'disabled' },
    })
    expect(config.tls).toEqual({ mode: 'disabled' })
    expect(config.upstreamOrigin.origin).toBe('http://127.0.0.1:3080')
    expect(config.maxConnections).toBe(64)
    expect(config.sessionTtlMs).toBe(8 * 60 * 60_000)
  })

  it('requires TLS, authorities, CIDRs, and absolute state for network exposure', () => {
    expect(() => parseGatewayConfig({
      listenHost: '0.0.0.0',
      listenPort: 3443,
      upstreamOrigin: 'http://127.0.0.1:3080',
      publicAuthorities: ['192.168.1.2:3443'],
      allowedCidrs: ['192.168.0.0/16'],
      stateFile,
      tls: { mode: 'disabled' },
    })).toThrow(/TLS may be disabled only/)

    expect(() => parseGatewayConfig({
      listenHost: '0.0.0.0',
      listenPort: 3443,
      upstreamOrigin: 'http://127.0.0.1:3080',
      allowedCidrs: ['192.168.0.0/16'],
      stateFile,
      tls: { mode: 'provided', certFile: join(TMP_ROOT, 'cert.pem'), keyFile: join(TMP_ROOT, 'key.pem') },
    })).toThrow(/publicAuthorities/)

    expect(() => parseGatewayConfig({
      listenHost: '0.0.0.0',
      listenPort: 3443,
      upstreamOrigin: 'http://127.0.0.1:3080',
      publicAuthorities: ['192.168.1.2:3443'],
      stateFile,
      tls: { mode: 'provided', certFile: join(TMP_ROOT, 'cert.pem'), keyFile: join(TMP_ROOT, 'key.pem') },
    })).toThrow(/allowedCidrs/)

    expect(() => parseGatewayConfig({
      stateFile: 'devices.json',
      tls: { mode: 'disabled' },
    })).toThrow(/absolute file path/)
  })

  it.each([
    'https://127.0.0.1:3080',
    'http://192.168.1.5:3080',
    'http://user:pass@127.0.0.1:3080',
    'http://127.0.0.1:3080/path',
    'http://127.0.0.1',
  ])('rejects unsafe upstream %s', (upstreamOrigin) => {
    expect(() => parseGatewayConfig({ stateFile, upstreamOrigin, tls: { mode: 'disabled' } })).toThrow(/upstreamOrigin/)
  })

  it('rejects ambiguous authority and CIDR entries', () => {
    expect(() => parseGatewayConfig({
      stateFile,
      tls: { mode: 'disabled' },
      publicAuthorities: ['127.0.0.1:3555'],
      listenPort: 3443,
    })).toThrow(/authority port/)
    expect(() => parseGatewayConfig({
      stateFile,
      tls: { mode: 'disabled' },
      allowedCidrs: ['192.168.1.7/24'],
    })).toThrow(/host bits/)
    expect(() => parseGatewayConfig({
      stateFile,
      tls: { mode: 'disabled' },
      publicAuthorities: ['https://127.0.0.1:3443'],
    })).toThrow(/authority/)
    expect(() => parseGatewayConfig({
      stateFile,
      listenPort: 0,
      tls: { mode: 'disabled' },
      publicAuthorities: ['127.0.0.1:3443'],
    })).toThrow(/non-zero listenPort/)
    expect(() => parseGatewayConfig({
      stateFile,
      tls: { mode: 'disabled' },
      allowedCidrs: ['127.0.0.0/8', '127.0.0.0/008'],
    })).toThrow(/duplicates/)
    expect(() => parseGatewayConfig({
      stateFile,
      tls: { mode: 'disabled' },
      maxConnections: 0,
    })).toThrow(/maxConnections/)
  })
})

describe('network trust policy', () => {
  it('matches IPv4, mapped IPv4, and IPv6 without broadening prefixes', () => {
    const cidrs = [parseCidr('192.168.0.0/16'), parseCidr('::1/128')]
    expect(addressAllowed('192.168.4.7', cidrs)).toBe(true)
    expect(addressAllowed('::ffff:192.168.4.7', cidrs)).toBe(true)
    expect(addressAllowed('192.169.4.7', cidrs)).toBe(false)
    expect(addressAllowed('::1', cidrs)).toBe(true)
    expect(addressAllowed(undefined, cidrs)).toBe(false)
  })

  it('requires exact authority and origin including the listener port', () => {
    const spec = parseAuthority('Harness.Example')
    expect(resolveAuthority(spec, 3443)).toBe('harness.example:3443')
    const policy = new RequestTrustPolicy([spec], 3443, [parseCidr('10.0.0.0/8')], true)
    expect(policy.acceptsHost('harness.example:3443')).toBe(true)
    expect(policy.acceptsHost('harness.example')).toBe(false)
    expect(policy.acceptsHost('harness.example:3444')).toBe(false)
    expect(policy.acceptsOrigin('https://harness.example:3443')).toBe(true)
    expect(policy.acceptsOrigin('http://harness.example:3443')).toBe(false)
    expect(policy.acceptsOrigin('https://harness.example:3443/path')).toBe(false)
  })

  it.each([
    { port: 443, tls: true, origin: 'https://harness.example' },
    { port: 80, tls: false, origin: 'http://harness.example' },
  ])('canonicalizes the default port for $origin', ({ port, tls, origin }) => {
    const policy = new RequestTrustPolicy(
      [parseAuthority('harness.example')],
      port,
      [parseCidr('10.0.0.0/8')],
      tls,
    )
    expect(policy.acceptsHost('harness.example')).toBe(true)
    expect(policy.acceptsOrigin(origin)).toBe(true)
    expect(policy.acceptsOrigin(`${origin}:${String(port)}`)).toBe(true)
  })

  it('rejects IP literal hosts unless allowIpLiteralHosts is enabled', () => {
    const policy = new RequestTrustPolicy(
      [parseAuthority('139.199.186.70:18443')],
      18443,
      [parseCidr('127.0.0.0/8')],
      true,
    )
    // 默认关闭：v6/v4 字面量 Host 一律拒绝
    expect(policy.acceptsHost('[2409:8a4c:d11:3de1::1]:18443')).toBe(false)
    expect(policy.acceptsHost('2409:8a4c:d11:3de1::1:18443')).toBe(false)
    expect(policy.acceptsHost('203.0.113.7:18443')).toBe(false)
    expect(policy.acceptsOrigin('https://[2409:8a4c:d11:3de1::1]:18443')).toBe(false)
  })

  it('accepts IP literal Host/Origin on the listener port when enabled', () => {
    const enabled = new RequestTrustPolicy(
      [parseAuthority('139.199.186.70:18443')],
      18443,
      [parseCidr('127.0.0.0/8')],
      true,
      true,
    )
    // IPv6 字面量（URL hostname 无括号）
    expect(enabled.acceptsHost('[2409:8a4c:d11:3de1:6e0b:84ff:fe81:d393]:18443')).toBe(true)
    expect(enabled.acceptsOrigin('https://[2409:8a4c:d11:3de1:6e0b:84ff:fe81:d393]:18443')).toBe(true)
    // v4 字面量同样放行
    expect(enabled.acceptsHost('203.0.113.7:18443')).toBe(true)
    expect(enabled.acceptsOrigin('https://203.0.113.7:18443')).toBe(true)
    // 端口必须等于监听端口；默认端口(443)不匹配 18443
    expect(enabled.acceptsHost('[2409:8a4c::1]')).toBe(false)
    expect(enabled.acceptsHost('[2409:8a4c::1]:443')).toBe(false)
    expect(enabled.acceptsHost('[2409:8a4c::1]:18444')).toBe(false)
    // 域名仍走精确表，不受开关影响
    expect(enabled.acceptsHost('evil.example:18443')).toBe(false)
    expect(enabled.acceptsOrigin('https://139.199.186.70:18443')).toBe(true)
    expect(enabled.acceptsOrigin('https://evil.example:18443')).toBe(false)
  })

  it('parses allowIpLiteralHosts from gateway config (default false)', () => {
    expect(parseGatewayConfig({
      stateFile,
      tls: { mode: 'disabled' },
      listenPort: 18443,
      allowIpLiteralHosts: true,
    }).allowIpLiteralHosts).toBe(true)
    expect(parseGatewayConfig({
      stateFile,
      tls: { mode: 'disabled' },
      listenPort: 18443,
    }).allowIpLiteralHosts).toBe(false)
  })
})
