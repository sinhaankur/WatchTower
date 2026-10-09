# Container Supply Chain — signing, SBOM, provenance

**Status:** implemented 2026-09-26 (`.github/workflows/publish-container.yml`)

Every WatchTower container image published to GHCR
(`ghcr.io/<owner>/watchtower`) ships with three supply-chain artifacts so a
consumer can answer *"is this really from WatchTower, and what's inside it?"*
without trusting the registry blindly:

1. **A cosign signature** (keyless, Sigstore) bound to the image **digest**.
2. **An SBOM** (SPDX) — the full software bill of materials.
3. **SLSA provenance** (`mode=max`) — how, where, and from which commit the
   image was built.

All three are attached to the image **digest**, not a mutable tag, so they
can't be invalidated by a later tag re-point.

---

## Why keyless signing

There is **no long-lived private key** to store, rotate, or leak. At build
time the workflow mints a short-lived GitHub OIDC token; Sigstore's Fulcio
exchanges it for an ephemeral certificate bound to *this repo's workflow
identity*, signs, and records the signature in the public Rekor transparency
log. The signing key exists for seconds and is thrown away. Verification
checks the signature against the GitHub OIDC issuer + the expected
repo/workflow identity — so a signature can only have been produced by this
repo's Actions workflow, not by anyone who cloned the repo or stole a secret.

This requires `id-token: write` + `attestations: write` on the job (already
set in the workflow).

---

## Verify an image before running it

### 1. Signature (cosign)

```bash
IMAGE=ghcr.io/<owner>/watchtower
DIGEST=$(crane digest $IMAGE:latest)   # or pin a specific vX.Y.Z tag

cosign verify "${IMAGE}@${DIGEST}" \
  --certificate-identity-regexp 'https://github.com/<owner>/WatchTower/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

A pass means the exact bytes at that digest were signed by this repo's
publish workflow. A fail means tampering, a typo-squatted image, or an
unsigned third-party copy — **do not run it.**

### 2. SBOM attestation (GitHub native)

```bash
gh attestation verify oci://ghcr.io/<owner>/watchtower@$DIGEST \
  --repo <owner>/WatchTower
```

To read the actual package list:

```bash
cosign download sbom "${IMAGE}@${DIGEST}"        # in-registry SPDX (buildx)
# or pull the SPDX-JSON attestation and inspect with syft/grype for CVEs:
grype "sbom:./sbom.spdx.json"
```

### 3. Provenance (SLSA)

```bash
cosign verify-attestation "${IMAGE}@${DIGEST}" \
  --type slsaprovenance \
  --certificate-identity-regexp 'https://github.com/<owner>/WatchTower/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The provenance records the base image, build args, and source commit — so
you can confirm an image was built from a specific tagged commit, not a
local hack.

---

## What the workflow does (the short version)

```
build+push (buildx, sbom:true, provenance:mode=max)   → image + in-registry SBOM + provenance
        │  digest
        ▼
cosign sign  ghcr.io/<owner>/watchtower@<digest>       → keyless signature in Rekor
        │
        ▼
syft scan <digest> → sbom.spdx.json
        │
        ▼
actions/attest-sbom  (push-to-registry)                → signed SBOM attestation on the digest
```

If the build produces no digest, the sign step fails loudly rather than
"signing nothing" — a guard against a silent regression that would publish
an unsigned image.

---

## Relationship to the desktop installers

This covers the **container** image only. The desktop DMG/AppImage/exe have
their own signing path (macOS Developer-ID + notarization, Windows Azure
Trusted Signing) wired in `release.yml`, verified by `verify-release.sh`.
Two separate distribution channels, two separate signing stories — don't
conflate them.
