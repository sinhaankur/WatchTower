# macOS code signing + notarization

This makes WatchTower's Mac builds **signed and notarized** so:

- Auto-update is seamless (no broken unsigned `quitAndInstall`, no flaky DMG path).
- First launch has **no Gatekeeper warning** ("unidentified developer").

It's **opt-in**: the release workflow only signs when the secrets below are
present. Without them, it falls back to the current unsigned build, so nothing
breaks for forks or before you've set this up.

## What you need (one-time, ~30 min)

1. **An Apple Developer account** — $99/yr at <https://developer.apple.com>.

2. **A "Developer ID Application" certificate.**
   - Xcode → Settings → Accounts → your team → **Manage Certificates** → `+` →
     **Developer ID Application**. (Or create it in the Developer portal.)
   - Export it from **Keychain Access** as a `.p12` (right-click the cert →
     Export; it must include the private key). Set a strong password — that's
     `MAC_CSC_KEY_PASSWORD`.
   - Base64-encode the `.p12` for the secret:
     ```bash
     base64 -i DeveloperID.p12 | pbcopy   # now in your clipboard
     ```
     That base64 string is `MAC_CSC_LINK`.

3. **An app-specific password** for notarization.
   - <https://appleid.apple.com> → Sign-In and Security → **App-Specific
     Passwords** → generate one (label it "watchtower-notarize").
   - That value is `APPLE_APP_SPECIFIC_PASSWORD`.

4. **Your Team ID** — the 10-character ID in the Developer portal
   (Membership details). That's `APPLE_TEAM_ID`.

5. **Your Apple ID email** — `APPLE_ID`.

## Add the 5 GitHub secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret name                   | Value                                            |
| ----------------------------- | ------------------------------------------------ |
| `MAC_CSC_LINK`                | base64 of the Developer-ID `.p12`                |
| `MAC_CSC_KEY_PASSWORD`        | the `.p12` export password                       |
| `APPLE_ID`                    | your Apple ID email                              |
| `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password from step 3            |
| `APPLE_TEAM_ID`               | your 10-char Team ID                             |

That's it. The next tagged release will produce signed + notarized macOS DMGs
automatically. The workflow detects `MAC_CSC_LINK` + `APPLE_TEAM_ID` and switches
on `-c.mac.notarize.teamId=...` (see `.github/workflows/release.yml`, the
"Build & publish installers" step).

## How to confirm a build is signed

After a release, on a Mac:

```bash
# Download + mount the DMG, then:
codesign --verify --deep --strict --verbose=2 "/Volumes/WatchTower .../WatchTower.app"
spctl --assess --type execute --verbose "/Volumes/WatchTower .../WatchTower.app"   # should say "accepted, source=Notarized Developer ID"
```

`scripts/verify-release.sh` checks artifact integrity + arch; signing is verified
with the two commands above (notarization status only shows on a real Mac).

## Notes

- The hardened-runtime **entitlements** live in `desktop/entitlements.mac.plist`
  (committed). They grant the JIT / unsigned-memory / library-validation
  exceptions Electron + the bundled Python need under the hardened runtime.
- Notarization adds ~2–5 min per Mac arch to the release (Apple's notary
  service round-trip). That's normal.
- Certificates expire (Developer ID Application certs last 5 years); rotate the
  `MAC_CSC_LINK`/`MAC_CSC_KEY_PASSWORD` secrets when you renew.
