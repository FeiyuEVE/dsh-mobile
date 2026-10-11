# Security policy

`dsh-mobile` exposes a control surface that can run tools on the host computer. Treat every paired device as security-sensitive.

## Supported versions

Security fixes target the newest stable release. Prereleases receive fixes only when the corresponding GitHub Release says they are supported. The README compatibility table identifies the exact DSH release tested with each plugin version.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability-reporting form for `saya-ch/dsh-mobile`. Include the affected version, deployment topology, reproduction steps, and whether a device credential, session Cookie, or local access is required.

The maintainer will acknowledge a complete report within seven days. Publication timing is coordinated with the reporter after a fix and a revocation or upgrade path are available.

## Deployment requirements

- Keep the ordinary DSH Web listener on loopback.
- Expose only the plugin-owned HTTPS listener to the LAN.
- DNS-SD/mDNS, periodic UDP announcements, active UDP query replies, and HTTPS discovery return only the device name, public HTTPS origin, port, protocol version, and stable non-secret installation identifier. Discovery never returns the CA, account credentials, session tokens, Cookies, or private configuration.
- Clients authenticate with the single configured account (username + password) over that HTTPS origin and receive one opaque **30-day** token. The token is delivered in two equivalent forms — `Authorization: Bearer` for native API calls and the same value in the `dsh_ma_session` cookie for WebView pages — and the server stores only its SHA-256 digest, so a server-side leak does not yield usable credentials. Mutating requests additionally require the token-bound CSRF header and an exact `Origin`.
- Browser clients require a certificate trusted by that browser platform (the gateway presents a publicly trusted certificate on the public entry). Client-side trust handling for the Android app is documented in that project's own repository.
- Keep the account password out of URLs, logs and command lines, and rotate it if it may have leaked (rotation revokes every existing token).
- Revoke a lost device's tokens immediately from the signed-in device list (`GET/POST /mobile-access/auth/tokens{,/revoke}`); if credential theft is suspected, revoke **all** tokens and change the password.
- Do not expose the LAN gateway through router port forwarding. Optional remote access uses a separate loopback gateway behind the selected Tailscale Funnel or cpolar service. The provider terminates public TLS, while DSH account authentication, CSRF checks, and token revocation remain enforced by the plugin gateway.
- The Funnel node stores its Tailscale login state under `$DSH_HOME/mobile-access/remote/tailscale/`. The plugin does not request or store a Tailscale password, Auth Key, or OAuth secret.
- cpolar is downloaded only after confirmation from a pinned official artifact whose size and SHA-256 are verified. Its Authtoken is stored in a private, self-update-disabled configuration under `$DSH_HOME/mobile-access/`, never returned by the admin API or written to logs. Cleanup removes the managed executable, configuration, logs, and independent remote device registry.
- Disabling remote access stops the selected provider process without affecting LAN access. Resetting remote access also removes provider state and the independent remote device registry.
- Treat every paired device as a fully trusted operator. Stock DSH methods reached through the authenticated loopback proxy may read configuration or run tools with the desktop user's authority.
- Treat `mobile.js` as application code with the paired page's same-origin authority. Restrict write access to trusted host-side DSH sessions and review generated API calls or browser-permission use.
- Treat every extension `host.mjs` as a local program with the desktop user's Node.js privileges. It is never sandboxed and is not editable through the mobile gateway; only place code there that you trust.
- Extension Actions and Routes receive filtered request data, a device identifier, and an abort signal. They cannot set proxy security headers or access the gateway's cookies, device tokens, CSRF tokens, or internal request headers.

## Known limitation

The current DSH HTML boot process contains inline JavaScript, revives Schemastery callbacks with `new Function`, and applies some styles dynamically. To keep the stock Web UI runnable, the gateway's Content Security Policy currently includes `script-src 'self' 'unsafe-inline' 'unsafe-eval'` and `style-src 'self' 'unsafe-inline'`. The remaining directives still restrict origins, connections, frames, objects, workers, images, and form targets, but this policy does not eliminate script-injection risk. Removing these allowances requires upstream DSH support for nonces, stable hashes, external boot resources, and a non-evaluating schema representation.

This repository never accepts private keys, npm tokens, pairing values, device credentials, Cookies, or captured settings in issues, logs, fixtures, or example configuration.
