# Windows code signing (Azure Trusted Signing)

This makes WatchTower's Windows installers **Authenticode-signed** so:

- No SmartScreen "Windows protected your PC" wall on install.
- The publisher name shows in the UAC prompt instead of "Unknown publisher".

It's **opt-in**, exactly like [macOS signing](MAC_CODE_SIGNING.md): the release
workflow signs only when the secrets below are present. Without them it builds
the current unsigned installers, so nothing breaks for forks or before setup.

## Why Azure Trusted Signing (not a classic OV/EV cert)

- ~$10/month vs $300–500/yr for an EV cert, and **no USB hardware token** —
  signing happens in CI against a cloud service.
- Certificates chain to a Microsoft-managed public root with short-lived
  certs, which gets SmartScreen reputation established much faster than a
  fresh OV cert.
- electron-builder ≥ 26 supports it natively (`win.azureSignOptions`).

Catch: Trusted Signing's identity validation currently favors organizations
with a verifiable history (3+ years) — individual validation exists but is
slower. If validation stalls, the fallback is a classic OV cert from SSL.com /
DigiCert; open an issue on this doc if that path is ever needed and we'll add
the `signtoolOptions` wiring.

## What you need (one-time, ~1–2 h + validation wait)

1. **An Azure account** with a subscription (the resource itself bills
   ~$9.99/month for the basic tier).

2. **A Trusted Signing account** (Azure portal → "Trusted Signing Accounts" →
   Create). Pick a region close to the GitHub runners (East US works). Note
   the **account name** and the region's **endpoint URL**, e.g.
   `https://eus.codesigning.azure.net`.

3. **Identity validation** (inside the Trusted Signing account → Identity
   validation). This is the step with a human/waiting component — Microsoft
   verifies the legal identity that will appear as the publisher name.
   *The name on the validation is the name users see in UAC prompts* — same
   decision as the Apple account: individual now vs. waiting for the corp.

4. **A certificate profile** (→ Certificate profiles → Create → **Public
   Trust**), linked to the validated identity. Note the **profile name**.

5. **An app registration** for CI auth (Microsoft Entra ID → App
   registrations → New):
   - Create a **client secret** (→ Certificates & secrets). Note the tenant
     ID, client (application) ID, and the secret value.
   - On the Trusted Signing account (IAM → Add role assignment), grant the app
     the **Trusted Signing Certificate Profile Signer** role.

## Add the 6 GitHub secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret name              | Value                                                |
| ------------------------ | ---------------------------------------------------- |
| `AZURE_SIGNING_ENDPOINT` | region endpoint, e.g. `https://eus.codesigning.azure.net` |
| `AZURE_SIGNING_ACCOUNT`  | the Trusted Signing account name                     |
| `AZURE_SIGNING_PROFILE`  | the certificate profile name                         |
| `AZURE_TENANT_ID`        | Entra tenant ID                                      |
| `AZURE_CLIENT_ID`        | app registration (client) ID                         |
| `AZURE_CLIENT_SECRET`    | the client secret value                              |

That's it. The next tagged release builds signed Windows installers: the
workflow detects `AZURE_SIGNING_ENDPOINT`, installs the `TrustedSigning`
PowerShell module on the runner, and passes `-c.win.azureSignOptions.*` to
electron-builder (see `.github/workflows/release.yml`, the "Build & publish
installers" step). Unsigned fallback stays intact when the secrets are absent.

## How to confirm a build is signed

On Windows:

```powershell
signtool verify /pa /v WatchTower-<version>-win-x64.exe
```

From macOS/Linux (`brew install osslsigncode`):

```bash
osslsigncode verify WatchTower-<version>-win-x64.exe
```

`scripts/verify-release.sh` runs the osslsigncode check on every release
automatically: unsigned → WARN (expected until this doc is actioned),
signed-and-valid → PASS, signed-but-broken → FAIL (block the release —
SmartScreen treats a broken signature worse than none).

## Interaction with auto-update

electron-updater on Windows verifies that an update's signature matches the
installed app's publisher. The release that first turns on signing is a
one-time transition: existing *unsigned* installs will still update to it
(unsigned apps don't enforce the check), but once users are on a signed
build, **never ship an unsigned release again** — their updater would reject
it. The verify-release.sh checks above exist to make that regression a
blocked release instead of a support incident.
