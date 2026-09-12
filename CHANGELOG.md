# Changelog

Notable changes to DSH Mobile are recorded here. GitHub Releases remain the source for downloadable packages and complete generated commit notes.

## 0.3.31 - 2026-09-12

- **Closing the right surface no longer strands it.** The dedicated layout only *mirrors* the right surface's own report of whether it is showing, so dismissing the drawer flipped that mirror and nothing else: the module that owns the expanded state stayed expanded and never reported again, because for it nothing had changed. On a phone the panel is fullscreen, and that module reconciles the frame's `canShow` only while it is not (`shown && !fullscreen && !canShow` — a fullscreen panel is not the frame's to collapse), so the two states stayed split: the drawer was hidden while its owner still believed it was showing. The damage lands on the panel's way back — the conversation header control that renders **only while the panel is collapsed** — so after the system back gesture (0.3.29's `__dshMobileHandleBack`) the file drawer could not be opened again; reproduced on the real page, which the old build left in exactly that state. The dismissal now asks that owner to collapse, i.e. the same action the panel's own collapse control performs, and the mirror-only close remains the fallback for a page where the owner never loaded. The scrim takes the same path, since tapping beside the panel does reach it on a phone: the drawer is 94vw wide, so a strip of scrim stays exposed.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.4 (already in the declared peer ranges).

## 0.3.30 - 2026-09-12

- **Enter inserts a line break on a soft keyboard.** The composer's keymap owns exactly two Enter gestures: plain Enter submits, Shift+Enter breaks the line — and a soft keyboard has no Shift, so on a phone the newline was unreachable and the only way to write a two-line message was to send the first line. The native surface now claims a plain Enter in the capture phase while the input mode is touch and asks for the line break through the input pipeline: `beforeinput`/`insertLineBreak` on `[data-composer-input]`, the editor root the composer owns. Measured against a trusted Shift+Enter in the real page, both land identically (`AAA\nBBB`, one `<br>` between the two text spans). A page without the `InputEvent` constructor keeps the desktop gesture rather than swallowing Enter. Every chord keeps its desktop meaning (Shift/Ctrl/Cmd/Alt+Enter pass through untouched, Ctrl/Cmd+Enter still submits), an IME-closing Enter is still the candidate pick rather than a gesture this page may reinterpret, and the Send button is unaffected. Once a physical keyboard has been observed (the surface already tracks Tab/arrow presses) the desktop gesture comes back. The editor root also carries `enterkeyhint="enter"` while in touch mode, so the keyboard's own key is labelled as the line break it now performs.
- **The system back gesture now acts on the surface instead of leaving the page.** The Android back gesture reaches the Activity, not the WebView, so it never touched the page: overlays the user opened stayed open and the gesture fell through to whatever the host app did with it. The surface now publishes `window.__dshMobileHandleBack()`, which closes the topmost mobile overlay from the live layout snapshot — the workspace drawer first (it sits above everything), then the right surface — and returns whether it closed anything; the host app calls it before falling back to its own WebView history or to exiting. It is answered from the layout controller, so it cannot disagree with what is on screen, and the handler is removed with the layout that owns it (a disposed surface never answers). Requires the Flutter host app to forward the gesture (dsh-mobile-flutter 0.5.1+96); an app that does not call it is unaffected.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.4 (already in the declared peer ranges).

## 0.3.29 - 2026-09-12

- Broken first attempt at the line break, superseded by 0.3.30 within the hour; install 0.3.30 or later. It claimed the plain Enter correctly (Enter stopped submitting) but replayed it as a **synthetic Shift+Enter keydown**, which the composer editor drops as an untrusted event, so Enter produced nothing at all instead of a newline. Measured on the real page: the replay left `AAABBB` with no break. The `window.__dshMobileHandleBack()` half of 0.3.29 is unchanged in 0.3.30.

## 0.3.28 - 2026-09-12

- Declare DeepSeek Harness 0.1.5-rc.2-local.4 compatible, because that release is where the phone's file panel actually starts working. The runtime version gate quarantines this plugin — and with it the whole plugin tree the mobile page boots — whenever the running dsh version is absent from `SUPPORTED_DSH_VERSIONS`, so the new version has to be named here **before** it is deployed to the gateway, not after. The four `peerDependencies` ranges gain it in the same release.
- That dsh release carries the fix for the failure this plugin spent 0.3.25–0.3.27 reporting. `protocolOf()` in `@deepseek-ai/dsh-client-resources` derived the resource type from `new URL(address).hostname`, and the target WebView (Huawei NOH-AL10, Android 12) parses a non-special scheme as cannot-be-a-base, so `hostname` is empty and **every** `dsh-resource://…` address reads as protocol `undefined` → registry status `none` → 「文件资源服务不可用。」, with no JavaScript error anywhere and no server-side symptom. Node and desktop Chromium answer `hostname: 'file'` for the same address, which is why the panel only ever failed on the phone. The fix reads the authority as a string instead, with a regression test that stubs a URL whose host is empty. Verified on the real device: the file opens.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.4 (newly declared).

## 0.3.27 - 2026-09-12

- Report the loader rows themselves, because that is where the missing `file` provider hides. A real phone page (Huawei NOH-AL10, Android 12, Chrome 114) reported the whole picture in 0.3.26 and it rules out everything server-side: `resources`, `remote` and `remote.workspaceFiles` are **all present**, `@deepseek-ai/dsh-api-workspace-files` **is** in the boot graph (58 entries), the host app's compat script did supply `Iterator` / `Promise.try` / `Promise.withResolvers` / `Math.sumPrecise` / `Uint8Array.fromBase64` / `Array.prototype.at` — and yet both the session-scoped and the session-less probe address answer `none`, with "文件资源服务不可用。" on screen. So the plugin that registers the provider is not doing it, even though every service it injects exists. The page now also reports `ctx.loader.entries()`: how many rows exist, and every row that is not `active` together with the injected services it is still waiting for. That is the one thing the boot audit cannot surface — `bootClient` runs `assertEntriesActive` only **after** `loader.await()`, so a row that never settles leaves the audit unreached and the page happily renders the plugins that did activate. It also reports how this engine's own `new URL()` parses the three resource address forms, since `protocolOf()` answers `undefined` — reported as `none` — for anything the URL parser rejects.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.3 (already in the declared peer ranges).

## 0.3.26 - 2026-09-12

- Make the dedicated mobile page report what it can actually see. A phone page really did report a missing `file` resource provider (2026-09-12T00:54:51Z, web entry `https://[…]:18443`, `frontend: dedicated`) while the same page served to a desktop browser has the provider registered and renders `data-textpreview-state="text"` for the same file — and because "文件资源服务不可用。" comes from a `status === 'none'` read with **no** JavaScript error, the error guard stayed silent and nothing in the log store separated the candidates. The page now sends one `mobile-page-state` report 20s after load carrying everything a server-side view cannot see: which of the three services the provider injects actually exist (`resources`, `remote`, `remote.workspaceFiles` — a missing one parks that plugin silently), the `file` protocol's status for two address forms (session-scoped and session-less), every open preview tab's address, state and status, whether the unavailable line is on screen, the boot `rev` and entry count plus whether `@deepseek-ai/dsh-api-workspace-files` is among them, whether the host app's document-start compat script actually supplied `Iterator` / `Promise.try` / `Promise.withResolvers` / `Math.sumPrecise` / `Uint8Array.fromBase64` / `Array.prototype.at` on that engine, and the user agent. It then reports each new preview tab (`document-preview-tab`) for up to ten minutes, at most five distinct address/state pairs, and every read is guarded: a diagnostic that breaks the page it observes is worse than none.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.3 (already in the declared peer ranges).

## 0.3.25 - 2026-09-12

- Drop the served page's WebView compatibility shim. 0.3.20 injected an `Iterator` shell plus `Promise.try` / `Math.sumPrecise` / `Uint8Array.fromBase64` guards into the mobile `<head>`, which was the right fix while the page had no other source for them — but the Flutter host app already injects the same set, and more (`AbortSignal.any`/`reason`/`throwIfAborted`, `Array.prototype.at`, `Promise.withResolvers`, `structuredClone`, `Iterator`, `Promise.try`, `Uint8Array.fromBase64`, `Math.sumPrecise`), as a document-start user script for the main frame only. Two owners of one contract means the page and the app can drift, and the shim's effect is invisible on any modern engine, so the tested-in-production copy is the app's and the server-side duplicate is gone. The layout tests were inverted accordingly: they now assert the gateway does **not** re-inject these, so a reintroduced copy fails loudly instead of silently.
- Report the one mobile failure that leaves no evidence. A document tab whose resource protocol has no registered provider renders 「文件资源服务不可用。」 and raises **no** JavaScript error, so the core client error guard — which captures `error`, `unhandledrejection` and `securitypolicyviolation` only — stays silent and the phone leaves nothing in the log store (observed 2026-09-12: a report of that panel, with no client-error entry anywhere). The dedicated mobile page now reads the registry directly (`ctx.resources.source(address).getSnapshot().status`, `none` exactly when the protocol has no provider) and, when the `file` protocol stays provider-less across a first check at 15s and a confirming check 30s later, reports `kind: resource-provider-missing`; a page where the whole `resources` service is absent reports `kind: resource-service-missing` instead. Delivery goes to the same-origin `POST /log-ingest` the core guard already uses, with the same envelope fields, the same `X-Log-Token` and `credentials: 'omit'`, and never a query string (a direct entry can carry the process token there). The probe waits for two answers precisely so a client graph that is merely slow to import is not reported, and every failure of its own — no token, blocked request, absent `fetch` — is swallowed: a diagnostic that breaks the page it observes is worse than none.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.3 (already in the declared peer ranges).

## 0.3.23 - 2026-09-11

- Make an open mobile page recover its Session by itself, so the "自动重连中…" (auto-reconnecting) chip clears instead of staying forever. The gateway authenticates with a short-lived **Session Cookie held in memory** plus a persistent device Cookie, so restarting the host — which restarts this gateway in the same process — invalidates every open page's Session while its device Cookie stays valid. From then on every same-origin request answers `401 {"error":"authentication_failed"}`, and the live channel (`/api/remote.mux`) handshake is rejected outright (`HTTP Authentication failed; no valid credentials`); the client only backs off (≤10s) and retries, it never renews, so the indicator never cleared (measured: still there after 240s) even though the page *looked* alive — its drawer and balances were projections rendered before the restart. Only a manual page reload recovered, because that navigation lands on `/mobile-access/login`, whose script POSTs the renew endpoint.
- The injected page bootstrap (previously CSRF-only, still running ahead of the boot manifest) now also drives recovery: a 401 from a same-origin `fetch` triggers one `POST /mobile-access/auth/renew` (coalesced across concurrent failures and rate-limited to once per 3s) and then replays that request once; a WebSocket handshake `error` triggers one renew, and the client's own ≤10s retry then carries the new Session; a 401 from renew itself (device revoked or expired) falls back to `location.replace('/mobile-access/login?return=…')`, exactly what the login landing already does. Recovery is failure-driven by design — a periodic renew would mint a Session and rewrite the device store on disk on every tick while the Session is perfectly alive.
- Move the gateway tests' fixed listener ports out of the kernel's ephemeral range (`38080/38081` → `61980/61981`). The host runs long-lived tunnels (`dsh-v6-front` forks a socat per connection) whose *outbound* sockets take ephemeral ports, so a phone connection parked on 38080 made every bind in `gateway.test.ts` fail with `EADDRINUSE` — 27 tests failing for a reason that had nothing to do with the code under test.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.3 (already in the declared peer ranges).

## 0.3.24 - 2026-09-11

- Stop the served mobile page from downloading the whole client payload twice. Upstream declares `<link rel="preload" as="script" href="/plugins/??…">` for the one combined client bundle it is about to execute, but this gateway replaces that bundle with its own content-addressed batch (`/mobile-access/mobile-boot/<hash>.js`), so the preload was never consumed — Chromium logged "preloaded using link preload but not used within a few seconds from the window's load event". Measured on a real phone-sized page (Playwright, iPhone 13): the preload still transferred **4.5 MB** (initiator `link`) alongside the **4.07 MB** batch. The rewrite now strips that preload link; other preloads on the page are left untouched. Re-pointing it at the batch was rejected deliberately: an `as=script` preload without `crossorigin` fetches in no-CORS mode while a module script fetch is CORS-mode, so it can never be reused for a module.

## 0.3.22 - 2026-09-11

- Composer toolbar back to one row on a phone. The native surface used to force a permanent two-row layout (`[data-dsh-mobile-composer-trailing] { flex:1 1 100% }` plus a stretched model trigger), which was written when the model trigger kept a visible name at any width. DeepSeek Harness 0.1.5 added its own container-query icon-only floor for that trigger (`@container (width<=360px)` in ui-model-selection hides the label and shows the Models glyph), so the forced row was now self-defeating: the trigger rendered icon-only **and** stretched to ~230px of empty pill, which both wrapped the row and consumed the width the dock cards above the composer need. The toolbar now keeps every group at its natural size, packs the trailing group to the right on the same line, and lets core's own wrap be the fallback for tablets where the label is visible.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.3 (already in the declared peer ranges).

## 0.3.21 - 2026-09-11

- Fix the empty session list in the mobile drawer. The dedicated mobile layout **replaces** the stock `@deepseek-ai/dsh-client-ui-layout` module, and that stock module also publishes a root hook source — `ctx.slots.provideRoot({ hooks: { panelInfo } })`. The slot runtime materializes each root hook source into the standard prop `use<Name>` on every descendant entry, so ui-sidebar's panel rows and session tree read it as `usePanelInfo`. The mobile layout registered its `root` slot without that contribution, so descendants received `undefined`; DeepSeek Harness 0.1.5's ui-sidebar started calling it, and the whole `sidebar.workspaces` entry threw `TypeError: usePanelInfo is not a function`. Symptom: the phone's drawer kept "new session / balance / settings" but rendered no sessions, while the page reported no HTTP error and no error outside the crashed slot. The layout now provides the hook itself, feeding the mobile controller's selected panel through `activePanelId` with a snapshot that keeps its identity until the selection changes (`useSyncExternalStore` compares with `Object.is`; a fresh object per read spins the renderer).
- Repair three test expectations that still used the pre-scope client module id `dsh-mobile`: the module id must equal its npm package name, so `rewriteMobileIndex`'s inject rewrite (and the bundle-patch row) had silently stopped being covered since the scoping commit. Add a regression test asserting that `apply()` publishes the root `panelInfo` contribution and that its snapshot/notification contract holds.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.3 (already in the declared peer ranges).

## 0.3.20 - 2026-09-11

- Inject a WebView compatibility script into the served mobile page's `<head>`, ahead of the boot manifest, so it runs before every client module bundle. Reason: DeepSeek Harness 0.1.5 added the client plugin `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`, whose bundled `yaml` library probes `typeof Iterator.prototype.join` with no guard. An engine without the `Iterator` global (Android WebView / Chrome < 122) throws `ReferenceError: Iterator is not defined` while the client module graph is being imported, and because DSH imports client plugins one by one, that single failure takes the **whole** client plugin graph down — the phone showed only the error-guard fallback screen (`Failed to load plugins`). Desktop Chromium has the global, so desktop testing never reproduced it.
- `Iterator` is installed as an empty shell with **no** `join`, deliberately: leaving `join` undefined keeps the upstream probe true, so the bundled `yaml` still installs its own polyfill — identical to a modern engine, and upstream semantics stay untouched. The script additionally shims `Promise.try` (Chrome 128+), `Math.sumPrecise` (137+) and `Uint8Array.fromBase64` (140+), which the bundled pdfjs in that same plugin reaches on its lazy PDF-preview paths; `Float16Array` is feature-detected by pdfjs itself. Every block is `typeof`-guarded and wrapped in `catch`, so a modern engine is unaffected and the script is idempotent.
- Compatibility verified against DeepSeek Harness 0.1.5-rc.2-local.3 (already in the declared peer ranges).

## 0.3.15 - 2026-09-09

- Keep the proxied `/plugins/events` SSE channel alive: the gateway applied its idle upstream socket timeout (`upstreamTimeoutMs`) to streamed responses, so a long-lived SSE with no events was destroyed at that deadline — the client saw `ERR_INCOMPLETE_CHUNKED_ENCODING` (production: every 300s) and the mobile app reloaded the whole page. Streaming (`text/event-stream`) responses now clear that timeout after the response headers arrive, matching the WebSocket branch, while session expiry and client disconnect still bound the connection.
- Stop compressing `text/event-stream` responses: the gzip transform buffers small frames (a handshake frame plus one event produced zero bytes for the client within 8s), which silently swallowed `/plugins/events` frames and left the channel with no traffic at all.
- Verify compatibility with DeepSeek Harness 0.1.2-alpha.4-local.1 (added to the declared peer ranges).

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
