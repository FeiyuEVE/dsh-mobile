/** Ephemeral certificate material generated independently for each test case. */
export interface TestTlsChain {
    readonly rootCert: string;
    readonly intermediateCert: string;
    readonly leafCert: string;
    readonly leafKey: string;
}
/** Generate a root, intermediate, and IP-address server leaf without durable private material. */
export declare function createTestTlsChain(): TestTlsChain;
//# sourceMappingURL=tls-fixtures.d.ts.map