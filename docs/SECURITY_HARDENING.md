# Security Hardening

> Moved out of the repo README (2026-07-02).

## Security

### Security Hardening

Recommended production setup:

```bash
export WATCHTOWER_API_TOKEN="change-this-to-a-long-random-token"
export WATCHTOWER_SECRET_KEY="$(python3 - <<'PY'
from cryptography.fernet import Fernet
print(Fernet.generate_key().decode())
PY
)"
```

Then run your service/deployment stack.

Notes:

- API auth uses timing-safe token comparison.
- Enterprise GitHub tokens are encrypted at rest with `WATCHTOWER_SECRET_KEY`.
- Insecure dev auth is disabled by default.

Dev-only bypass (never in production):

```bash
export WATCHTOWER_ALLOW_INSECURE_DEV_AUTH=true
```

### Secure Terminal Command Runner (Host Connect)

Host Connect includes a secure command runner for operational commands.

- Strict allowlist only (no arbitrary shell)
- Command-level sudo controls
- Encrypted execution audit log

Enable it by setting:

```bash
export WATCHTOWER_TERMINAL_AUDIT_KEY="$(python3 - <<'PY'
from cryptography.fernet import Fernet
print(Fernet.generate_key().decode())
PY
)"
```

If missing, terminal execution is disabled by design.

### Website Security Baseline (Recommended)

- Protect deploy API with strong `WATCHTOWER_TRIGGER_TOKEN`
- Keep API private to LAN/VPN where possible
- Apply firewall allowlists for admin/dev IPs
- Use dedicated non-root deploy user on nodes
- Keep `sudoers` narrow (avoid broad `NOPASSWD:ALL`)
- Enforce SSH key-based auth; disable password auth
- Enforce HTTPS/TLS and modern security headers
- Centralize logs, rotate logs, keep backups, and test rollback plans

Minimal safe deployment checks:

```bash
sudo systemctl status watchtower-appcenter
curl http://<server-ip>:8000/health
```

For internet-facing deployments, place App Center behind VPN/auth gateway.

### Security CI (Automated)

- Workflow: `.github/workflows/security-scan.yml`
- Triggered on PRs and pushes to `main`
- Scans filesystem and built container image
- Fails on HIGH/CRITICAL vulnerabilities (except unfixed CVEs)

---

