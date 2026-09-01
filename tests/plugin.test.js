import { Context } from '@deepseek-ai/cordis';
import { createServer, request as requestHttp } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOG_QUERY_TOKEN } from '../src/plugin.js';
import { afterEach, describe, expect, it } from 'vitest';
import { Config, parseGatewayConfig } from '../src/config.js';
import { parseCidr, RequestTrustPolicy } from '../src/network.js';
import { apply, inject, remoteGatewayConfig } from '../src/plugin.js';
import { DSH_MOBILE_VERSION, MINIMUM_ANDROID_APP_VERSION } from '../src/version.js';
const contexts = [];
const temporaryDirectories = [];
afterEach(async () => {
    await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()));
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function invoke(route, method, path, body = '', extraHeaders = {}) {
    const server = createServer((request, response) => { void route.handler(request, response); });
    await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    try {
        return await new Promise((resolve, reject) => {
            const request = requestHttp({
                host: '127.0.0.1',
                port,
                method,
                path,
                headers: {
                    host: `127.0.0.1:${String(port)}`,
                    ...extraHeaders,
                    ...(method === 'POST' ? {
                        origin: `http://127.0.0.1:${String(port)}`,
                        'sec-fetch-site': 'same-origin',
                        'content-type': 'application/json',
                        'content-length': Buffer.byteLength(body),
                    } : {}),
                },
            }, (response) => {
                const chunks = [];
                response.on('data', chunk => chunks.push(Buffer.from(chunk)));
                response.on('end', () => resolve({
                    status: response.statusCode ?? 0,
                    body: Buffer.concat(chunks).toString('utf8'),
                }));
            });
            request.once('error', reject);
            if (body !== '')
                request.write(body);
            request.end();
        });
    }
    finally {
        await new Promise(resolve => { server.close(() => resolve()); });
    }
}
async function mount(initiallyEnabled = false) {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-plugin-'));
    temporaryDirectories.push(directory);
    let command;
    const routes = new Map();
    const context = new Context();
    contexts.push(context);
    context.provide('webServer', {
        register(candidate) {
            routes.set(candidate.path, candidate);
            return () => { routes.delete(candidate.path); };
        },
    });
    context.provide('commands', {
        register(definition) {
            command = definition;
            return () => { if (command === definition)
                command = undefined; };
        },
    });
    context.provide('connection', {
        authenticatedUrl(baseUrl) {
            return `${baseUrl}/?token=test-launch-token`;
        },
    });
    await context.plugin({ Config, inject, apply }, {
        listenPort: 38083,
        stateFile: join(directory, 'devices.json'),
        controlFile: join(directory, 'control.json'),
        customCssFile: join(directory, 'mobile.css'),
        customScriptFile: join(directory, 'mobile.js'),
        initiallyEnabled,
        tls: { mode: 'disabled' },
    });
    const route = routes.get('/api/mobile-access');
    if (route === undefined)
        throw new Error('plugin did not register its control route');
    const logsRoute = routes.get('/api/mobile-logs');
    if (logsRoute === undefined)
        throw new Error('plugin did not register its logs query route');
    if (command === undefined)
        throw new Error('plugin did not register its /mobile command');
    return { context, route, logsRoute, command };
}
describe('remote Funnel gateway configuration', () => {
    it('keeps public HTTPS on 443 when the private listener uses an ephemeral port', () => {
        const template = parseGatewayConfig({
            listenHost: '127.0.0.1',
            listenPort: 0,
            publicAuthorities: ['127.0.0.1'],
            allowedCidrs: ['127.0.0.0/8'],
            stateFile: join(tmpdir(), 'dsh-mobile-remote-template.json'),
            tls: { mode: 'disabled' },
        });
        const publicHost = 'dsh-14a71b788377-1.tail775400.ts.net';
        const config = remoteGatewayConfig(template, `https://${publicHost}`, join(tmpdir(), 'dsh-mobile-remote-devices.json'), 'a'.repeat(64));
        const policy = new RequestTrustPolicy(config.authorities, 58_916, [parseCidr('127.0.0.0/8')], config.publicTls);
        expect(config.authorities).toEqual([{ hostname: publicHost, port: 443 }]);
        expect([...policy.origins]).toEqual([`https://${publicHost}`]);
        expect(policy.acceptsHost(publicHost)).toBe(true);
        expect(policy.acceptsOrigin(`https://${publicHost}`)).toBe(true);
        expect(policy.acceptsHost(`${publicHost}:58916`)).toBe(false);
        expect(policy.acceptsOrigin(`https://${publicHost}:58916`)).toBe(false);
    });
    it('allows a transport-owned fixed loopback port without changing the public authority', () => {
        const template = parseGatewayConfig({
            listenHost: '127.0.0.1',
            listenPort: 0,
            publicAuthorities: ['127.0.0.1'],
            allowedCidrs: ['127.0.0.0/8'],
            stateFile: join(tmpdir(), 'dsh-mobile-remote-template.json'),
            tls: { mode: 'disabled' },
        });
        const config = remoteGatewayConfig(template, 'https://example.r8.cpolar.cn', join(tmpdir(), 'dsh-mobile-cpolar-devices.json'), 'b'.repeat(64), 45_321);
        expect(config.listenPort).toBe(45_321);
        expect(config.authorities).toEqual([{ hostname: 'example.r8.cpolar.cn', port: 443 }]);
    });
});
describe('stock DSH lifecycle', () => {
    it('requires the WebServer, commands, and Connection services', () => {
        expect(inject).toEqual(['webServer', 'commands', 'connection']);
    });
    it('keeps a loopback control route available while the LAN listener is stopped', async () => {
        const mounted = await mount();
        expect(mounted.route).toMatchObject({ kind: 'prefix', path: '/api/mobile-access' });
        const status = await invoke(mounted.route, 'GET', '/api/mobile-access/control');
        expect(status.status).toBe(200);
        expect(JSON.parse(status.body)).toEqual({ running: false });
        const remote = await invoke(mounted.route, 'GET', '/api/mobile-access/remote/control');
        expect(remote.status).toBe(200);
        expect(JSON.parse(remote.body)).toMatchObject({
            provider: 'tailscale',
            running: false,
            state: 'off',
            providers: {
                tailscale: { bundled: true, running: false, state: 'off' },
                cpolar: {
                    bundled: false,
                    running: false,
                    state: 'off',
                    component: { installed: false, configured: false },
                },
            },
        });
        const diagnostics = await invoke(mounted.route, 'GET', '/api/mobile-access/diagnostics');
        expect(diagnostics.status).toBe(200);
        expect(JSON.parse(diagnostics.body)).toMatchObject({
            version: 1,
            overall: expect.stringMatching(/^(?:ok|attention|error)$/),
            versions: { plugin: DSH_MOBILE_VERSION, minimumAndroidApp: MINIMUM_ANDROID_APP_VERSION },
            checks: expect.any(Array),
            report: expect.stringContaining('DSH Mobile 诊断报告'),
        });
    });
    it('starts and stops the gateway through the local control route', async () => {
        const mounted = await mount();
        const started = await invoke(mounted.route, 'POST', '/api/mobile-access/control', JSON.stringify({ running: true }));
        expect(started.status).toBe(200);
        expect(JSON.parse(started.body)).toMatchObject({ running: true });
        const stopped = await invoke(mounted.route, 'POST', '/api/mobile-access/control', JSON.stringify({ running: false }));
        expect(stopped.status).toBe(200);
        expect(JSON.parse(stopped.body)).toEqual({ running: false });
    });
    it('switches remote providers without changing the LAN runtime', async () => {
        const mounted = await mount();
        const selected = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/provider', JSON.stringify({ provider: 'cpolar' }));
        expect(selected.status).toBe(200);
        expect(JSON.parse(selected.body)).toMatchObject({ provider: 'cpolar', running: false, state: 'off' });
        const lan = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control');
        expect(JSON.parse(lan.body)).toEqual({ running: false });
    });
    it('registers a /mobile command that steers the agent with the customization guide', async () => {
        const mounted = await mount();
        expect(mounted.command).toMatchObject({
            name: 'mobile',
            description: expect.any(String),
            input: { hint: expect.any(String) },
        });
        const steered = [];
        const agent = {
            steer: (message) => {
                steered.push({ text: message.content[0]?.text ?? '', source: message.source });
            },
            whenIdle: async () => undefined,
        };
        const invoke = (rawInput) => mounted.command.handler({
            agent,
            commandId: 'id',
            signal: new AbortController().signal,
            rawInput,
        });
        const empty = invoke('  ');
        expect(empty).toMatchObject({ kind: 'error' });
        expect(steered).toEqual([]);
        const result = invoke(' 把手机端改成深色主题');
        expect(result).toMatchObject({ kind: 'success' });
        expect(steered.length).toBe(1);
        const [steeredMessage] = steered;
        expect(steeredMessage).toBeDefined();
        expect(steeredMessage.text).toContain('mobile-access');
        expect(steeredMessage.text).toContain('把手机端改成深色主题');
        // The guide rides as a plugin-source context injection, not a user bubble.
        expect(steeredMessage.source).toMatchObject({
            kind: 'plugin',
            plugin: 'dsh-mobile',
            form: 'notice',
            summary: '/mobile 把手机端改成深色主题',
        });
    });
    it('registers the logs query route and requires its token', async () => {
        const mounted = await mount();
        // 无查询令牌 → 401；有令牌才进入 ES 代理分支（测试环境 ES 不可达，返回 5xx 而非 401）
        const denied = await invoke(mounted.logsRoute, 'GET', '/api/mobile-logs?limit=10', '');
        expect(denied.status).toBe(401);
        const allowed = await invoke(mounted.logsRoute, 'GET', '/api/mobile-logs?limit=10', '', { 'x-log-query': LOG_QUERY_TOKEN });
        expect(allowed.status).not.toBe(401);
        // 本机测试环境 ES 可达时返回 200；异机返回 5xx。两条路径都证明令牌放行。
        expect(allowed.status).toBeLessThan(500);
    });
});
//# sourceMappingURL=plugin.test.js.map