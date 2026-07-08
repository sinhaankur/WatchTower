"""Guided SSH setup — managed deploy keypair + GET /api/this-pc/ssh-key.

ssh-keygen is present on dev/CI hosts, so we generate a real key into a tmp
WATCHTOWER_DATA_DIR. The only thing that ever leaves the host is the public key.
"""
from __future__ import annotations

import os
import stat

import pytest

from watchtower import ssh_setup


@pytest.fixture
def tmp_data(monkeypatch, tmp_path):
    monkeypatch.setenv("WATCHTOWER_DATA_DIR", str(tmp_path))
    return tmp_path


def _have_ssh_keygen() -> bool:
    import shutil
    return shutil.which("ssh-keygen") is not None


pytestmark = pytest.mark.skipif(not _have_ssh_keygen(), reason="ssh-keygen not available")


def test_ensure_keypair_generates_then_is_idempotent(tmp_data):
    assert ssh_setup.key_exists() is False
    ok, _ = ssh_setup.ensure_keypair()
    assert ok is True
    assert ssh_setup.key_exists() is True

    priv = ssh_setup.private_key_path()
    pub = ssh_setup.public_key_path()
    assert priv.is_file() and pub.is_file()
    # Private key must be 0600.
    mode = stat.S_IMODE(os.stat(priv).st_mode)
    assert mode == 0o600, oct(mode)

    # Second call reuses the key (same content), doesn't regenerate.
    before = priv.read_bytes()
    ok2, msg2 = ssh_setup.ensure_keypair()
    assert ok2 is True
    assert "already exists" in msg2.lower()
    assert priv.read_bytes() == before


def test_public_key_is_ed25519(tmp_data):
    ssh_setup.ensure_keypair()
    pub = ssh_setup.read_public_key()
    assert pub is not None
    assert pub.startswith("ssh-ed25519 ")
    assert "watchtower-deploy" in pub


def test_authorize_oneliner_embeds_key(tmp_data):
    ssh_setup.ensure_keypair()
    pub = ssh_setup.read_public_key()
    cmd = ssh_setup.authorized_keys_oneliner(pub)
    assert "authorized_keys" in cmd
    assert pub in cmd
    assert "chmod 600" in cmd


# ── endpoint ─────────────────────────────────────────────────────────────────


def test_ssh_key_requires_auth(anon_client):
    assert anon_client.get("/api/this-pc/ssh-key").status_code == 401


def test_ssh_key_returns_public_key_only(client, tmp_data):
    r = client.get("/api/this-pc/ssh-key")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["public_key"].startswith("ssh-ed25519 ")
    assert body["private_key_path"].endswith("watchtower_deploy_ed25519")
    assert "authorized_keys" in body["authorize_command"]
    # The private key material itself is never in the response.
    assert "PRIVATE KEY" not in r.text
