# DeepSeek Harness Android App

[简体中文](README.zh-CN.md) · [Back to the project](../../README.en.md)

DeepSeek Harness is the display name of this lightweight, community-maintained Android WebView shell. It does not bundle a second DSH frontend. The app and mobile browsers load the same authenticated HTTPS origin, so both receive the same DSH features plus live-editable `mobile.css` presentation and `mobile.js` functionality.

Android is the only supported native target. The iOS client remains an unpublished local experiment and is outside the build, release, and support scope.

## Use the app

1. Complete the plugin quick start and run `dsh-mobile setup`.
2. Install the Android APK from GitHub Releases.
3. Select **Create and copy key** or **Copy pairing link** in **Mobile Access** in desktop DSH; the panel shows a pairing QR code.
4. Open the app, tap **Scan QR code**, and point the camera at the screen to pair — or tap **Scan**, select the discovered DSH, and paste the key or pairing link, which the app resolves into origin and token.
5. Connect. Certificate trust stays private to the app; Android settings are not changed.

After the first pairing, the app encrypts a revocable, long-lived device token with Android Keystore. Every later launch uses it to renew a short Web session before opening DSH, so the pairing key is not requested again unless the device is revoked, the trust expires, or app data is cleared. If the computer receives another LAN address, the app scans the default port, matches the stable DSH installation identifier, and updates the saved origin automatically. Discovery never exposes the device token or Session credentials.

Discovery listens to DNS-SD/mDNS and periodic UDP announcements at the same time, sends an active UDP query on port `3443`, and retains bounded HTTPS scans of visible private Wi-Fi and phone-hotspot `/24` networks as a compatibility fallback. Every discovery path carries metadata only and results are merged by stable installation identifier, so a changed address updates the existing device. The first screen offers **Scan QR code** (point the camera at the screen to pair without a key), Scan, a result list, and a manual address field (enter `https://IP:port` to connect when discovery fails, e.g. across subnets, on a non-default port, or behind a firewall); select one DSH before entering its key. For a browser's first connection, open the **Copy pairing link** link on the phone (the pairing code is prefilled), or visit `/mobile-access/pair` on the shown HTTPS origin and enter the 43-character pairing code after the generated key's final dot.

The CA is not discovery data. After selection and key entry, Android retrieves it from the chosen origin without sending credentials, checks that its SHA-256 fingerprint matches the key and installation identifier, and stores it with the encrypted device credential. Native requests use an app-private trust store. WebView accepts only an otherwise-untrusted leaf signed by that pinned CA for the exact origin and validity period; every other TLS error is cancelled. No system CA installation is required.

## Why use the app

- No browser address or tab bars.
- System Back navigates same-origin WebView history first.
- File selection, same-origin downloads, sharing, and site-data clearing use narrow native implementations.
- The app remains a shell around the same Web UI and protocol used by browsers.

A mobile browser is always a first-class alternative; the app is optional.

## Security properties

| Control | Android behavior |
| --- | --- |
| Transport | HTTPS origins only; cleartext traffic is disabled. |
| TLS | The pairing-key CA is stored privately. Only `SSL_UNTRUSTED` for its valid, exact-host leaf is accepted; every other TLS error is cancelled. |
| Origin | Only scheme, normalized host, and port persist. Ordinary paths, queries, and fragments do not. |
| Navigation | Same-origin main frames stay inside; user-initiated external HTTPS links open in the system browser. |
| Permissions | File input uses the system document picker; the camera is requested only when the user taps **Scan QR code**, to read the pairing QR. |
| Downloads | Foreground GET from the exact origin only; authentication control paths are never downloads. |
| Data | The device token is encrypted by Android Keystore; Web storage stays in the app sandbox; Clear Site Data removes the credential, origin, cookies, cache, and Web storage. |
| Backup | App backup is disabled; TLS private keys and signing keys must remain outside the repository. |

The network security configuration does not trust user-installed CAs. The plugin signs a fresh SAN for the selected interface's current address while the app retains the stable CA pin in its encrypted credential record.

## Build

Requirements: Android Studio or Android SDK 36, JDK 17, and Gradle 8.11.1.

```powershell
Set-Location apps/mobile/android
gradle wrapper --gradle-version 8.11.1
./gradlew.bat :app:testDebugUnitTest :app:assembleDebug
```

The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`. Alpha Releases use ephemeral debug signing. A production release requires a stable signing key kept outside the repository and a signed release APK or AAB.

## Acceptance

Shared URL-policy tests cover origin normalization, pairing entry, same-origin navigation, and download paths. Device acceptance must still cover small screens, landscape, cutouts and gestures, the keyboard, font scaling, valid and invalid TLS, file input, downloads, Back, rotation, and reauthentication after clearing data.

Apache-2.0 licensed. See [LICENSE](../../LICENSE).
