import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CPOLAR_COMPONENT_RELEASE, CpolarComponentManager, validateCpolarAuthtoken, } from '../src/cpolar-component.js';
const temporaryDirectories = [];
afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
describe('managed cpolar component', () => {
    it('pins the official artifact and rejects malformed tokens', () => {
        expect(CPOLAR_COMPONENT_RELEASE.downloadUrl).toMatch(/^https:\/\/www\.cpolar\.com\//u);
        expect(CPOLAR_COMPONENT_RELEASE.downloadSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(CPOLAR_COMPONENT_RELEASE.executableSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(validateCpolarAuthtoken('a'.repeat(32))).toBe('a'.repeat(32));
        expect(() => validateCpolarAuthtoken('short')).toThrow('cpolar_authtoken_invalid');
        expect(() => validateCpolarAuthtoken(`a${'b'.repeat(30)}\n`)).toThrow('cpolar_authtoken_invalid');
    });
    it('keeps the token in private component state and purges all owned files', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cpolar-component-'));
        temporaryDirectories.push(directory);
        const manager = new CpolarComponentManager({ stateDirectory: directory, platform: 'win32', arch: 'x64' });
        await manager.initialize();
        expect(manager.status()).toMatchObject({ supported: true, installed: false, configured: false });
        const token = 'token-value-with-enough-characters-1234';
        await manager.configure(token);
        expect(manager.status()).toMatchObject({ installed: false, configured: true });
        expect(JSON.stringify(manager.status())).not.toContain(token);
        const config = await readFile(manager.configFile, 'utf8');
        expect(config).toContain(JSON.stringify(token));
        expect(config).toContain('update: false');
        expect(config).toContain('inspect_db_size: -1');
        expect((await lstat(manager.configFile)).isFile()).toBe(true);
        await manager.purge();
        expect(manager.status()).toMatchObject({ installed: false, configured: false });
        await expect(lstat(manager.configFile)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('reports unsupported hosts without attempting a download', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cpolar-component-'));
        temporaryDirectories.push(directory);
        const manager = new CpolarComponentManager({ stateDirectory: directory, platform: 'linux', arch: 'x64' });
        await manager.initialize();
        expect(manager.status()).toMatchObject({ supported: false, installed: false });
        await expect(manager.install()).rejects.toThrow('cpolar_component_unsupported');
    });
});
//# sourceMappingURL=cpolar-component.test.js.map