# Security policy

`dsh-mobile` exposes a control surface that can run tools on the host computer. Treat every paired device as security-sensitive.

## Supported versions

Only the newest prerelease receives security fixes while the project is in alpha. The README compatibility table identifies the exact DSH release tested with each plugin version.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability-reporting form for `saya-ch/dsh-mobile`. Include the affected version, deployment topology, reproduction steps, and whether a device credential, session Cookie, or local access is required.

The maintainer will acknowledge a complete report within seven days. Publication timing is coordinated with the reporter after a fix and a revocation or upgrade path are available.

## Deployment requirements

- Keep the ordinary DSH Web listener on loopback.
- Expose only the plugin-owned HTTPS listener to the LAN.
- DNS-SD/mDNS, periodic UDP announcements, active UDP query replies, and HTTPS discovery return only the device name, public HTTPS origin, port, protocol version, and stable non-secret installation identifier. Discovery never returns the CA, a pairing key, a device token, Cookies, credentials, or private configuration.
- Only after a user selects a device and enters the fingerprint-bound pairing key may Android fetch the public CA from that exact HTTPS origin. The bootstrap GET sends no key or credential. The app retains the CA in its encrypted credential record and never adds it to Android's system trust settings. Native requests use a private trust store; WebView accepts only the otherwise-untrusted leaf signed by that CA, for the exact origin and validity period. Every other TLS error is cancelled.
- Browser clients require a certificate trusted by that browser platform. Android uses the pairing-key-bound app-private CA. Its WebView exception is restricted to `SSL_UNTRUSTED` for an exact-origin, currently valid leaf signed by that CA; hostname, validity, signature, and every other TLS error remain fail-closed.
- Keep pairing closed except during a short local onboarding action.
- Revoke a lost device immediately and rotate the device registry if credential theft is suspected.
- Do not expose the gateway directly to the public Internet.
- Treat every paired device as a fully trusted operator. Stock DSH methods reached through the authenticated loopback proxy may read configuration or run tools with the desktop user's authority.
- Treat `mobile.js` as application code with the paired page's same-origin authority. Restrict write access to trusted host-side DSH sessions and review generated API calls or browser-permission use.

## Known alpha limitation

The current DSH HTML boot process contains inline JavaScript, revives Schemastery callbacks with `new Function`, and applies some styles dynamically. To keep the stock Web UI runnable, the gateway's Content Security Policy currently includes `script-src 'self' 'unsafe-inline' 'unsafe-eval'` and `style-src 'self' 'unsafe-inline'`. The remaining directives still restrict origins, connections, frames, objects, workers, images, and form targets, but this policy does not eliminate script-injection risk. Removing these allowances requires upstream DSH support for nonces, stable hashes, external boot resources, and a non-evaluating schema representation.

This repository never accepts private keys, npm tokens, pairing values, device credentials, Cookies, or captured settings in issues, logs, fixtures, or example configuration.
