import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configuredRemoteProvider, JsonRemoteProviderStore, parseRemoteProviderState } from '../src/remote.js';
const temporaryDirectories = [];
afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
describe('remote provider selection', () => {
    it('accepts only one supported provider and no extra fields', () => {
        expect(parseRemoteProviderState({ version: 1, provider: 'tailscale' })).toEqual({ version: 1, provider: 'tailscale' });
        expect(parseRemoteProviderState({ version: 1, provider: 'cpolar' })).toEqual({ version: 1, provider: 'cpolar' });
        expect(() => parseRemoteProviderState({ version: 1, provider: 'other' })).toThrow('unsupported format');
        expect(() => parseRemoteProviderState({ version: 1, provider: 'cpolar', token: 'secret' })).toThrow('unsupported format');
    });
    it('uses the environment only for the first-run default', async () => {
        expect(configuredRemoteProvider({})).toBe('tailscale');
        expect(configuredRemoteProvider({ DSH_MOBILE_REMOTE_PROVIDER: 'cpolar' })).toBe('cpolar');
        expect(() => configuredRemoteProvider({ DSH_MOBILE_REMOTE_PROVIDER: 'invalid' })).toThrow('must be tailscale or cpolar');
        const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-remote-provider-'));
        temporaryDirectories.push(directory);
        const file = join(directory, 'state', 'provider.json');
        const store = new JsonRemoteProviderStore(file, 'tailscale');
        expect(await store.load()).toEqual({ version: 1, provider: 'tailscale' });
        await store.save({ version: 1, provider: 'cpolar' });
        expect(await new JsonRemoteProviderStore(file, 'tailscale').load()).toEqual({ version: 1, provider: 'cpolar' });
    });
});
//# sourceMappingURL=remote.test.js.map