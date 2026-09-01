import { describe, expect, it } from 'vitest';
import { parseCpolarOrigin } from '../src/cpolar.js';
describe('cpolar log protocol', () => {
    it('accepts only provider HTTPS origins', () => {
        expect(parseCpolarOrigin('time="now" level=info msg="Tunnel established at http://example.r8.cpolar.cn"')).toBeUndefined();
        expect(parseCpolarOrigin('time="now" level=info msg="Tunnel established at https://example.r8.cpolar.cn"'))
            .toBe('https://example.r8.cpolar.cn');
        expect(parseCpolarOrigin('Tunnel established at https://example.cpolar.io')).toBe('https://example.cpolar.io');
    });
    it('rejects lookalike, credentialed, and non-root origins', () => {
        expect(() => parseCpolarOrigin('Tunnel established at https://example.cpolar.cn.evil.test')).toThrow('invalid_cpolar_origin');
        expect(() => parseCpolarOrigin('Tunnel established at https://user@example.cpolar.cn')).toThrow('invalid_cpolar_origin');
        expect(() => parseCpolarOrigin('Tunnel established at https://example.cpolar.cn/path')).toThrow('invalid_cpolar_origin');
    });
});
//# sourceMappingURL=cpolar.test.js.map