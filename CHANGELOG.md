# Changelog

Notable changes to DSH Mobile are recorded here. GitHub Releases remain the source for downloadable packages and complete generated commit notes.

## 0.3.14 - 2026-09-05

- Add an opt-in `allowIpLiteralHosts` switch to the `mobile-access` plugin config (off by default). When enabled, the gateway's external-trust policy (`RequestTrustPolicy`) also accepts requests whose Host header (and, for browser mutations, same-origin requests whose Origin) has an IP-literal hostname — IPv4 or IPv6 — on the bound listener port. Rationale: the public IPv6 direct-connect entry `https://[公网IPv6]:18443/18452` carries a dynamic SLAAC address that cannot be pre-registered in `publicAuthorities`, and without this switch those requests 403 `forbidden` on the exact-Host check. IP literals never go through DNS, so the DNS-rebinding protection the exact-Host check exists for is not weakened; socket CIDR and session/pairing auth still gate every request.
- (previous 0.3.14 unreleased items below)

## 0.3.14 - 2026-09-04

- Add an opt-in Service Worker static cache for the mobile page (`staticCacheWorker` in the `mobile-access` plugin config; off by default). Some WebView engines (observed: Huawei ArkWeb on Android 12) do not persist the gateway's large gzip/chunked responses in the HTTP disk cache, so every page entry re-downloaded the full plugin combo, Vite assets and the mobile boot batch (measured: the same content-addressed URLs fetched with full 200s on every one of 21 entries in a day, including 3-4 duplicate in-flight fetches of the same URL in a single load). When enabled, the rewritten mobile index registers a gateway-served worker (`/mobile-access/sw.js`, scope `/`) that answers revisioned `/plugins/*`, `/assets/*` and `/mobile-access/mobile-boot/*` GETs from Cache Storage — independent of the engine HTTP cache — with single-flight coalescing for duplicate requests, and prunes entries older than one week after each successful navigation. Cache entries are keyed by content-addressed URLs, so a hit is never stale.
- The gateway now serves the mobile boot batch (content-addressed 64-hex URL derived from the DSH mobile version and the entry graph) as `private, max-age=31536000, immutable` instead of `private, no-cache`: a different version or graph is a different URL, so long-lived browser caching is safe and removes a per-entry revalidation/redownload of the ~370 KB layout bundle. The ETag is retained for conditional requests.
- (unreleased items carried below)

## 0.3.13 - 2026-09-03

- Follow-up on 0.3.12: the dedicated mobile layout could still leave the native backdrop up after React had closed the drawer. Two hardening changes make the stuck layer structurally impossible:
  - Dedicated-layout detection now keys on the presence of the `dshm` main column instead of the *absence* of a core `_frame` element. The suffix matcher (`classToken` = `endsWith`) could match an unrelated `*_frame` class in some session views, which made the sync treat the dedicated page as the desktop layout, fail to find a sidebar, and return before ever converging the backdrop.
  - In the dedicated layout the native backdrop (`z-235` full-screen dim button) is now always hidden; the drawer open/close and its dim are owned exclusively by the mobile-layout React scrim. The earlier "two state machines" desync class disappears entirely. Non-dedicated (mobile browser on the desktop layout) behaviour is unchanged.
- The gateway now answers `GET /favicon.ico` / `/favicon.png` with 204 before session authorization, so browser/WebView boot-time favicon fetches no longer 401 (they previously surfaced as per-load http-error warnings in the app's log; app-side filtering remains as a second line of defence).
- (unreleased items carried below)

## 0.3.12 - 2026-09-03

- Fix the stuck full-screen dim layer after switching sessions in the dedicated mobile layout ("grey overlay that blocks taps until the app is killed", watchdog-verified: `.dshm-scrim` open / `.dsh-native-mobile-backdrop` visible with nothing left to close it). Root cause: the native mobile surface's mutation-driven sync tagged the `dshm` drawer container as its own sidebar and re-wrote the drawer's `data-open` attribute from the core sidebar's collapse class, creating two competing state machines (React layout vs native CSS panel) that could desync and leave the backdrop/panel up after React had already closed the drawer. The sync also depended on an uninterrupted mutation → rAF chain.
  - In the dedicated layout the sync no longer overwrites the drawer's `data-open` (the React layout owns it exclusively; the native panel CSS now follows React directly).
  - The native backdrop now hides whenever React reports the drawer closed (`data-open` on the scrim), instead of waiting for the core sidebar's 150 ms collapse settle, and no longer depends on a continuously healthy observer chain (2 s safety heartbeat re-runs the idempotent sync).
  - Tapping the backdrop now closes through the React path first (scrim click); the core-toggle fallback only applies on non-dedicated surfaces.
- (unreleased items carried below)

## 0.3.11 - 2026-09-03

- Relax the gateway CSP from `base-uri 'none'` to `base-uri 'self'`: the DSH core `frontend-static` injects a same-origin `<base href="/">` into the served index (SPA deep-link asset anchoring), so the old policy made every page load raise a `securitypolicyviolation`. The page error guard queued each violation and retried delivery every 5 s; on direct-gateway connections (no nginx relay) every attempt 403'd forever, flooding the mobile app's http-error log and losing client-error telemetry. A same-origin base adds no XSS surface.
- Add an unauthenticated-by-token `POST /log-ingest` passthrough route on the gateway (`X-Log-Token` allowlist identical to the public nginx relay: deployment token and page token). Direct-gateway pages now forward page error-guard reports to the same local logstash HTTP channel the nginx 18447 tunnel uses, so queued client errors drain instead of retrying 403 every 5 s.
- (unreleased items carried below)

## 0.3.10 - 2026-09-02

- Support the DSH 0.1.2-alpha.4 web frontend on mobile: its settings module no longer injects the connection client, so the gateway now appends the connection client to the settings dependency graph instead of failing the mobile index rewrite (which previously surfaced as an `upstream_unavailable` 502 right after pairing).
- When an upstream index rewrite still cannot be completed, relay the raw upstream page instead of answering 502, so a paired mobile session always lands on something usable and the failure stays visible in gateway logs.

## Unreleased


- Inject `AbortSignal.any` and `Promise.withResolvers` boot polyfills into gateway documents, so old Android System WebView releases (e.g. Chrome 114 on Android 12) can start the DSH connection instead of failing before the client bundle runs.

## 0.3.2 - 2026-08-29

- Special thanks to @JackRushante for [#16](https://github.com/saya-ch/dsh-mobile/pull/16): the secure Android media bridge, image attachments, localization foundation, bounded extension requests, and Funnel lifecycle hardening. This release retains all four original commits and their author metadata.
- Move image selection and camera capture into a dedicated top row of the composer command menu, without focusing the message editor.
- Push extension and `/mobile` changes to authenticated phones immediately, while retaining bounded polling as a network-recovery fallback.
- Bind each mobile UI to its matching Host, script, style, and asset generation; retain the previous Host through a bounded refresh window, fail closed on client activation errors, and tighten scoped requests against encoded path traversal.
- Bound long-running Android picker and camera interactions, release temporary provider grants across success, cancellation, timeout, rotation, and Activity teardown, and retain compatibility with supported WebView releases.
- Split mobile language dictionaries into dedicated modules; make native Android screens follow the system locale in Simplified Chinese, English, or Italian; make plugin-owned Web UI follow DSH's selected locale; and retain Italian resources for future DSH support.
- Correct the mobile extension and Funnel documentation, and record the Android runtime libraries shipped with the app.

## 0.3.1 - 2026-08-28

- Credit @BlueandwhiteXD ([#15](https://github.com/saya-ch/dsh-mobile/pull/15)) for the Android keyboard inset report and fix incorporated into the 0.3 mobile layout.

## 0.3.0 - 2026-08-28

- Add one-click connection diagnostics for versions, LAN gateway, network interface, Windows firewall, and the selected remote provider, with a sanitized report for support requests.
- Publish compatibility metadata separately from the stable discovery protocol so the Android app can distinguish app, plugin, and protocol mismatches.
- Keep the connection chooser interactive during background restoration, race saved LAN and remote trust, reuse trust after remote address changes, apply remote-aware timeouts and single-flight refresh backoff, and privately cache revisioned assets for faster reopening.
- Preserve fallback discovery when Android 13+ nearby Wi-Fi permission is declined, and provide concise guidance for QR, pairing, session, rate-limit, and service failures.
- Forward authenticated DSH and plugin mutations with CSRF protection, restoring mobile plugin-market and other non-GET actions.
- Coordinate Android and Web status-bar and safe-area behavior, keep settings actions readable on narrow screens, and refresh the app icon.
- Support DeepSeek Harness 0.1.2-alpha.1, including its `/api/remote.mux` state channel and batched renderer boot, so Workspaces, model selection, sessions, and community plugins remain available on mobile.
- Compress dedicated mobile boot batches and harden Android WebView origin checks, reducing remote startup transfer while avoiding background-thread WebView access.

## 0.2.2 - 2026-08-27

- Detect LAN and remote pairing links automatically after a QR scan, independent of the currently selected connection page.
- Clarify QR, network, firewall, certificate, and pairing failures so users can identify the shortest recovery path.

## 0.2.1 - 2026-08-25

- Add a stable Android app download entry to the desktop Mobile Access panel.

## 0.2.0 - 2026-08-24

- Add independent LAN and remote access flows with separate paired-device stores.
- Add optional Tailscale Funnel and managed cpolar remote providers.
- Restore saved Android connections automatically and improve mobile loading over limited links.
- Page older session history on demand and compress eligible gateway responses.
- Build the pinned Funnel host from source and publish checksums, an SBOM, and third-party notices.

## 0.1.4 - 2026-08-23

- Keep the plugin compatible with DeepSeek Harness 0.1.1.
- Continue mobile layout, safe-area, composer, settings, and interaction improvements.
- Restore bounded native response reads on Android 10 through 12.
- Publish Android releases as reproducible, signed release builds instead of temporary debug builds.
- Preserve the existing mobile protocol so older app builds can continue using the updated plugin; switching from the previous temporary Android signature requires one uninstall and re-pair.
- Refresh CI actions, Android lint coverage, build tooling, and maintenance documentation.

## 0.1.3 - 2026-08-23

- Added DeepSeek Harness 0.1.1 compatibility.
- Improved mobile layout and interaction behavior.
