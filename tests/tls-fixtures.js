import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
function lengthBytes(length) {
    if (length < 0x80)
        return Buffer.from([length]);
    const hex = length.toString(16).padStart(Math.ceil(length.toString(16).length / 2) * 2, '0');
    const bytes = Buffer.from(hex, 'hex');
    return Buffer.concat([Buffer.from([0x80 | bytes.length]), bytes]);
}
function der(tag, ...parts) {
    const value = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([tag]), lengthBytes(value.length), value]);
}
function sequence(...parts) {
    return der(0x30, ...parts);
}
function set(...parts) {
    return der(0x31, ...parts);
}
function integerBytes(value) {
    let offset = 0;
    while (offset < value.length - 1 && value[offset] === 0)
        offset += 1;
    const significant = value.subarray(offset);
    return significant[0] >= 0x80 ? Buffer.concat([Buffer.from([0]), significant]) : Buffer.from(significant);
}
function integer(value) {
    if (typeof value !== 'number')
        return der(0x02, integerBytes(value));
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error('DER integer must be a non-negative safe integer');
    if (value === 0)
        return der(0x02, Buffer.from([0]));
    let hex = value.toString(16);
    if (hex.length % 2 !== 0)
        hex = `0${hex}`;
    return der(0x02, integerBytes(Buffer.from(hex, 'hex')));
}
function base128(value) {
    const bytes = [Number(value & 0x7fn)];
    for (let remaining = value >> 7n; remaining > 0n; remaining >>= 7n) {
        bytes.unshift(Number(remaining & 0x7fn) | 0x80);
    }
    return bytes;
}
function objectIdentifier(source) {
    const components = source.split('.').map(BigInt);
    const first = components[0];
    const second = components[1];
    if (first === undefined || second === undefined || first > 2n || second < 0n
        || (first < 2n && second > 39n) || components.slice(2).some(value => value < 0n)) {
        throw new Error('invalid test certificate object identifier');
    }
    const encoded = [
        ...base128(first * 40n + second),
        ...components.slice(2).flatMap(base128),
    ];
    return der(0x06, Buffer.from(encoded));
}
function boolean(value) {
    return der(0x01, Buffer.from([value ? 0xff : 0]));
}
function octetString(value) {
    return der(0x04, value);
}
function bitString(value, unusedBits = 0) {
    return der(0x03, Buffer.concat([Buffer.from([unusedBits]), value]));
}
function commonName(value) {
    return sequence(set(sequence(objectIdentifier('2.5.4.3'), der(0x0c, Buffer.from(value, 'utf8')))));
}
function time(date) {
    const year = date.getUTCFullYear();
    const components = [
        String(year).padStart(4, '0'),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0'),
        String(date.getUTCHours()).padStart(2, '0'),
        String(date.getUTCMinutes()).padStart(2, '0'),
        String(date.getUTCSeconds()).padStart(2, '0'),
        'Z',
    ];
    if (year >= 1950 && year < 2050) {
        components[0] = components[0].slice(2);
        return der(0x17, Buffer.from(components.join(''), 'ascii'));
    }
    return der(0x18, Buffer.from(components.join(''), 'ascii'));
}
function extension(identifier, critical, value) {
    return sequence(objectIdentifier(identifier), ...(critical ? [boolean(true)] : []), octetString(value));
}
function signatureAlgorithm() {
    return sequence(objectIdentifier('1.2.840.10045.4.3.2'));
}
function serialNumber() {
    const serial = randomBytes(16);
    serial[0] = serial[0] & 0x7f;
    if (serial.every(value => value === 0))
        serial[serial.length - 1] = 1;
    return serial;
}
function certificate(options) {
    const subjectPublicKey = options.publicKey.export({ type: 'spki', format: 'der' });
    const body = sequence(der(0xa0, integer(2)), integer(serialNumber()), signatureAlgorithm(), options.issuer, sequence(time(options.notBefore), time(options.notAfter)), options.subject, subjectPublicKey, der(0xa3, sequence(...options.extensions)));
    return sequence(body, signatureAlgorithm(), bitString(sign('sha256', body, options.issuerKey)));
}
function pem(label, value) {
    const encoded = value.toString('base64');
    const lines = encoded.match(/.{1,64}/gu);
    if (lines === null)
        throw new Error('failed to encode test certificate material');
    return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
function ecKeyPair() {
    return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}
/** Generate a root, intermediate, and IP-address server leaf without durable private material. */
export function createTestTlsChain() {
    const root = ecKeyPair();
    const intermediate = ecKeyPair();
    const leaf = ecKeyPair();
    const rootName = commonName('DSH Mobile Test Root');
    const intermediateName = commonName('DSH Mobile Test Intermediate');
    const leafName = commonName('127.0.0.1');
    const notBefore = new Date(Date.now() - 60_000);
    const notAfter = new Date(Date.now() + 24 * 60 * 60_000);
    const caKeyUsage = extension('2.5.29.15', true, bitString(Buffer.from([0x06]), 1));
    const rootCert = certificate({
        subject: rootName,
        issuer: rootName,
        publicKey: root.publicKey,
        issuerKey: root.privateKey,
        notBefore,
        notAfter,
        extensions: [
            extension('2.5.29.19', true, sequence(boolean(true), integer(1))),
            caKeyUsage,
        ],
    });
    const intermediateCert = certificate({
        subject: intermediateName,
        issuer: rootName,
        publicKey: intermediate.publicKey,
        issuerKey: root.privateKey,
        notBefore,
        notAfter,
        extensions: [
            extension('2.5.29.19', true, sequence(boolean(true), integer(0))),
            caKeyUsage,
        ],
    });
    const leafCert = certificate({
        subject: leafName,
        issuer: intermediateName,
        publicKey: leaf.publicKey,
        issuerKey: intermediate.privateKey,
        notBefore,
        notAfter,
        extensions: [
            extension('2.5.29.19', true, sequence()),
            extension('2.5.29.15', true, bitString(Buffer.from([0x80]), 7)),
            extension('2.5.29.37', false, sequence(objectIdentifier('1.3.6.1.5.5.7.3.1'))),
            extension('2.5.29.17', false, sequence(der(0x87, Buffer.from([127, 0, 0, 1])))),
        ],
    });
    return Object.freeze({
        rootCert: pem('CERTIFICATE', rootCert),
        intermediateCert: pem('CERTIFICATE', intermediateCert),
        leafCert: pem('CERTIFICATE', leafCert),
        leafKey: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
}
//# sourceMappingURL=tls-fixtures.js.map