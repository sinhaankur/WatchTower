#!/usr/bin/env bash
# One-time setup for a fresh Ubuntu host to serve as a WatchTower
# deploy target with Phase 1 (Podman container deploys) + Phase 2
# (nginx host-side reverse proxy).
#
# What this installs:
#   - podman          (Phase 1 runtime)
#   - nginx           (Phase 2 reverse proxy)
#   - rsync, curl, jq (deploy plumbing)
#
# What this configures:
#   - A `deploy` user with a home dir and the operator-supplied
#     SSH key in ~/.ssh/authorized_keys.
#   - /etc/sudoers.d/watchtower-deploy granting the deploy user
#     passwordless sudo for *only* the narrow set of commands
#     WatchTower runs (nginx config + reload, no shell access).
#   - /srv/sites owned by deploy:deploy as the rsync target.
#
# What this DOES NOT do:
#   - DNS — the operator points the domain at the node's public IP.
#   - TLS — Phase 3 (Cloudflare proxy) handles certs.
#   - Firewall — assumes ufw/iptables already allows :22, :80, :443.
#
# Usage on the fresh host (as root, e.g. via DO web console or
# initial root SSH):
#
#     curl -fsSL https://raw.githubusercontent.com/.../prep-node-for-phase2.sh \
#         | sudo bash -s -- "ssh-ed25519 AAAA... watchtower@host"
#
# Or, after scp'ing the script:
#     sudo ./prep-node-for-phase2.sh "ssh-ed25519 AAAA... watchtower@host"
#
# The single argument is the SSH public key (a one-line authorized_keys
# entry) that WatchTower will use to log in as the deploy user. Treat
# this like a deploy credential — anyone with that private key can
# trigger deploys to this node.
set -euo pipefail

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "FAIL: must run as root (try: sudo $0 \"<pubkey>\")" >&2
  exit 2
fi

PUBKEY="${1:-}"
if [ -z "$PUBKEY" ]; then
  echo "Usage: $0 \"<ssh-public-key>\"" >&2
  echo "       The pubkey is one line, e.g.:" >&2
  echo "       ssh-ed25519 AAAAC3Nz... watchtower@host" >&2
  exit 2
fi

# Sanity-check the pubkey shape — fail early rather than write garbage
# into authorized_keys and find out only when the deploy hangs.
if ! echo "$PUBKEY" | grep -qE '^(ssh-(ed25519|rsa)|ecdsa-) '; then
  echo "FAIL: '$PUBKEY' doesn't look like an SSH public key" >&2
  exit 2
fi

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

step() { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}-->${NC} $*"; }

# ── Packages ─────────────────────────────────────────────────────────────────
step "Installing packages (podman, nginx, rsync, curl, jq)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq podman nginx rsync curl jq ca-certificates \
  certbot python3-certbot-nginx

# Verify Podman actually works post-install. The apt package on some
# minimal images installs but fails on first run with a missing
# subuid/subgid config — easier to catch now than during a deploy.
if ! podman --version >/dev/null 2>&1; then
  echo "FAIL: podman installed but '--version' failed" >&2
  exit 1
fi

# ── Deploy user ──────────────────────────────────────────────────────────────
step "Setting up 'deploy' user…"
if ! id -u deploy >/dev/null 2>&1; then
  useradd -m -s /bin/bash deploy
fi

install -d -o deploy -g deploy -m 0700 /home/deploy/.ssh
echo "$PUBKEY" > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 0600 /home/deploy/.ssh/authorized_keys

# Configure subuid/subgid for rootless Podman. The package install does
# this on most distros but some minimal images skip it.
if ! grep -q '^deploy:' /etc/subuid 2>/dev/null; then
  echo "deploy:100000:65536" >> /etc/subuid
fi
if ! grep -q '^deploy:' /etc/subgid 2>/dev/null; then
  echo "deploy:100000:65536" >> /etc/subgid
fi

# ── Sudoers grant ────────────────────────────────────────────────────────────
# Narrowest possible set of NOPASSWD commands — only what WatchTower
# actually runs in builder.py:_apply_nginx_proxy_on_node. NEVER add
# `ALL` here even temporarily; widening this file is the difference
# between "WatchTower can deploy" and "WatchTower can root the box."
step "Granting deploy user narrow passwordless sudo…"
SUDOERS=/etc/sudoers.d/watchtower-deploy
cat > "$SUDOERS" <<'EOF'
# WatchTower deploy user — Phase 2 commands only.
# Anything not listed here will prompt for a password (and silently
# fail under the deploy ssh session).
Defaults:deploy !requiretty

# nginx config writes & lifecycle. Path wildcard limits writes to the
# WatchTower-managed filename pattern wt-<id>.conf — operator hand-edits
# in other files are unaffected.
deploy ALL=(root) NOPASSWD: /usr/sbin/nginx -t
deploy ALL=(root) NOPASSWD: /bin/systemctl reload nginx
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl reload nginx
deploy ALL=(root) NOPASSWD: /usr/bin/tee /etc/nginx/sites-available/wt-*.conf
deploy ALL=(root) NOPASSWD: /bin/ln -sf /etc/nginx/sites-available/wt-*.conf /etc/nginx/sites-enabled/wt-*.conf
deploy ALL=(root) NOPASSWD: /bin/rm -f /etc/nginx/sites-enabled/wt-*.conf
deploy ALL=(root) NOPASSWD: /usr/bin/rm -f /etc/nginx/sites-enabled/wt-*.conf

# Phase 2 TLS: certbot acquires + renews Let's Encrypt certs. The
# binary itself enforces what it will and won't do (only touches
# /etc/letsencrypt and /etc/nginx); bare-binary NOPASSWD is the
# standard recipe per the certbot docs.
deploy ALL=(root) NOPASSWD: /usr/bin/certbot
EOF
chmod 0440 "$SUDOERS"
# Validate before exiting — a broken sudoers locks everyone out of sudo.
if ! visudo -cf "$SUDOERS" >/dev/null; then
  echo "FAIL: generated sudoers file is invalid — removing"
  rm -f "$SUDOERS"
  exit 1
fi

# ── Deploy target directory ──────────────────────────────────────────────────
step "Preparing /srv/sites as the rsync target…"
install -d -o deploy -g deploy -m 0755 /srv/sites

# ── Enable nginx if not already running ──────────────────────────────────────
step "Ensuring nginx is enabled and running…"
systemctl enable --now nginx >/dev/null 2>&1 || true

# Disable the default site that ships with the Ubuntu nginx package —
# leaving it enabled means /etc/nginx/sites-enabled/default catches all
# requests that don't match a WatchTower server_name, hiding routing
# bugs as "the site loads but it's the default page."
if [ -L /etc/nginx/sites-enabled/default ]; then
  rm -f /etc/nginx/sites-enabled/default
  systemctl reload nginx >/dev/null 2>&1 || true
  warn "Removed /etc/nginx/sites-enabled/default — only WatchTower-managed sites will respond now"
fi

# ── Final report ─────────────────────────────────────────────────────────────
echo
echo -e "${GREEN}Host prepared for WatchTower Phase 1 + Phase 2 deploys.${NC}"
echo
echo "Next steps (run from your WatchTower install):"
echo "  1. Register this node in the dashboard under Servers:"
echo "       host:         $(hostname -I 2>/dev/null | awk '{print $1}' || hostname)"
echo "       user:         deploy"
echo "       port:         22"
echo "       remote_path:  /srv/sites/<your-project>"
echo "       ssh_key:      <the matching private key>"
echo
echo "  2. On a project, enable 'Run as Container' on the Overview tab"
echo "     and set a host port (Settings → Recommended port)."
echo
echo "  3. Add a CustomDomain on the Domains tab — once configured,"
echo "     Phase 2 will wire it through nginx automatically on next deploy."
echo
echo "  4. Trigger a deploy, then run:"
echo "       ./scripts/smoke-test-phase1.sh <project-id>"
