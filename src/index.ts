/**
 * Authenticated LAN gateway for the existing DSH Web application. The ordinary
 * Web listener remains loopback-only; this package owns the only listener
 * intended for phones. Credentials are a single account: username + password
 * exchanged for a one-month opaque token (pairing/device mode was removed).
 */
export { AccessError, BoundedRateLimiter } from './access.js'
export type { SessionAuthorization } from './access.js'
export {
  AccountController,
  DEFAULT_TOKEN_TTL_MS,
  JsonAccountStore,
  JsonTokenStore,
  MemoryAccountStore,
  MemoryTokenStore,
  parseAccountSnapshot,
  parseTokenSnapshot,
  tokenSnapshotLimit,
} from './account.js'
export type {
  AccountControllerOptions,
  AccountLoginResult,
  AccountRecord,
  AccountSnapshot,
  AccountStore,
  AccountTokenSummary,
  TokenRecord,
  TokenSnapshot,
  TokenStore,
} from './account.js'
export { Config, parseControlFile, parseGatewayConfig } from './config.js'
export { assertSupportedDshVersion, SUPPORTED_DSH_VERSIONS } from './compatibility.js'
export type {
  DisabledTlsConfig,
  PluginConfig,
  ProvidedTlsConfig,
  ResolvedGatewayConfig,
  TlsConfig,
} from './config.js'
export {
  JsonMobileAccessControlStore,
  MobileAccessGatewayController,
  parseMobileAccessControlState,
} from './control.js'
export type {
  MobileAccessControlState,
  MobileAccessControlStore,
  MobileAccessRuntime,
} from './control.js'
export { MobileAccessGateway, rewriteMobileIndex } from './gateway.js'
export {
  EXTENSION_LIMITS,
  MobileAccessService,
  MobileExtensionError,
  assertExtensionId,
  createMobileAccessService,
  parseExtensionManifest,
} from './extensions.js'
export type {
  LocalExtensionManifest,
  MobileAccessService as MobileAccessRegistry,
  MobileActionContext,
  MobileExtensionClientEntry,
  MobileExtensionDefinition,
  MobileExtensionManifest,
  MobileExtensionStatus,
  MobileHostAction,
  MobileHostRoute,
  MobileRouteRequest,
  MobileRouteResponse,
} from './extensions.js'
export {
  AUTH_PREFIX,
  CSRF_COOKIE,
  CSRF_HEADER,
  LOCAL_ADMIN_PREFIX,
  SESSION_COOKIE,
  WS_PATHS,
} from './http-security.js'
export {
  addressAllowed,
  isLoopbackAddress,
  parseAuthority,
  parseCidr,
  RequestTrustPolicy,
  resolveAuthority,
} from './network.js'
export type { AuthoritySpec, ParsedCidr } from './network.js'
export { apply, inject, name } from './plugin.js'
