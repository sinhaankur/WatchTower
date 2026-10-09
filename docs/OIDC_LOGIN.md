# Generic OIDC / SSO Login

**Status:** implemented 2026-09-28

WatchTower supports **any spec-compliant OpenID Connect provider** for login,
alongside the built-in GitHub flows. This is the provider-agnostic identity
path: Google, GitLab, Okta, Authentik, Keycloak, Microsoft Entra, Auth0, etc.
all work through one config-driven flow.

When configured, the login page shows a **"Sign in with &lt;provider&gt;"**
button next to the GitHub option. Everything downstream (session token, org
membership, audit log) is identical regardless of which provider a user
signed in with.

## Setup (3 steps)

1. **Register a confidential OIDC/OAuth client** with your provider. Set its
   redirect URI to:

   ```
   https://<your-watchtower-host>/oauth/oidc/login/callback
   ```

2. **Set the env vars** (or the desktop/`.env`):

   ```bash
   WATCHTOWER_OIDC_ISSUER=https://accounts.google.com
   WATCHTOWER_OIDC_CLIENT_ID=<client id>
   WATCHTOWER_OIDC_CLIENT_SECRET=<client secret>
   WATCHTOWER_OIDC_PROVIDER_NAME=Google        # button label (optional)
   ```

   Endpoints are auto-discovered from
   `<issuer>/.well-known/openid-configuration`. Override only for
   non-standard providers:

   ```bash
   WATCHTOWER_OIDC_AUTHORIZE_URL=...
   WATCHTOWER_OIDC_TOKEN_URL=...
   WATCHTOWER_OIDC_USERINFO_URL=...
   WATCHTOWER_OIDC_SCOPES="openid email profile"   # default
   ```

3. **Restart.** The button appears automatically (`GET /api/auth/oidc/status`
   drives its visibility).

## Provider issuer cheat-sheet

| Provider | `WATCHTOWER_OIDC_ISSUER` |
|----------|--------------------------|
| Google | `https://accounts.google.com` |
| GitLab (SaaS) | `https://gitlab.com` |
| Okta | `https://<your-org>.okta.com` |
| Authentik | `https://<host>/application/o/<app-slug>/` |
| Keycloak | `https://<host>/realms/<realm>` |
| Microsoft Entra | `https://login.microsoftonline.com/<tenant>/v2.0` |
| Auth0 | `https://<tenant>.auth0.com/` |

## How identity maps to a WatchTower user

- The user is keyed by **`<issuer>|<sub>`** (`users.oidc_subject`) — the
  OIDC-guaranteed stable, per-issuer subject. Two different providers can't
  collide on a bare `sub`.
- On first login a new `User` is created. If the provider returns a
  **verified** email that matches an existing account (e.g. someone who
  previously used GitHub with the same email), the accounts are linked
  instead of duplicated. Unverified emails are never trusted for linking.
- If the provider returns no email at all, a stable placeholder
  (`oidc-<hash>@users.noreply.watchtower.local`) is synthesised so the
  account is still usable.

## Security notes

- Every provider URL (issuer, authorize, token, userinfo) is run through the
  same **SSRF guard** as GHES (`assert_safe_external_url`) before any
  server-side request — an operator can't be tricked into pointing OIDC at a
  cloud metadata endpoint. Local-dev bypass: `WATCHTOWER_ALLOW_INTERNAL_HTTP=true`.
- **CSRF**: the `state` parameter is HMAC-signed and time-limited (15 min),
  reusing the same signing machinery as the GitHub flow.
- **Replay**: a `nonce` is generated per login and checked against the
  returned `id_token`.
- **v0 boundary (documented, not an oversight):** the `id_token` signature is
  not yet verified against the provider's JWKS. Token authenticity comes from
  the confidential-client back-channel exchange over TLS (client_secret +
  direct fetch from the token endpoint), which is the standard
  Authorization-Code-flow trust model. JWKS signature verification is a
  planned hardening follow-up. See `watchtower/oidc.py`.

## Relationship to GitHub auth

GitHub OAuth, GitHub Device Flow, GitHub Enterprise, and generic OIDC all
coexist. A deployment can enable any combination; the login page renders a
button for each configured method. They all mint the same signed WatchTower
session token via `create_user_session_token`.
