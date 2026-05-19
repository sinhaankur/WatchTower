"""Phase 5 step 2: the orchestrator that turns a saved provider
credential into a ready-to-deploy OrgNode.

State machine (matches ProvisioningJob.status):

    queued
      ↓                  generate keypair, call provider.create_server
    creating_vm
      ↓                  poll provider.get_server_status every 5s
    waiting_for_ready    until status='active'/'running' AND public_ipv4 present
      ↓                  upload prep-node-for-phase2.sh, run it via SSH
    installing_stack
      ↓                  SSH probes: nginx -t, podman --version, systemctl is-active
    verifying
      ↓                  insert OrgNode row pointing at this VM
    registered (terminal-success)

Any step can transition to ``failed`` (terminal). On failure AFTER
``creating_vm`` has produced a provider_resource_id, the orchestrator
calls provider.delete_server to avoid orphaning a billable VM on the
operator's account. This cleanup-on-failure is the most operationally
critical part of the file — a successful provision is happy-path; a
failed-but-clean-up provision is what stops users from being billed
for our bugs.

The orchestrator runs as an asyncio task spawned from the API request
handler. The API returns the job_id immediately so the UI can poll.
Restarting the API mid-provision currently abandons the in-flight job
(it'll sit in a non-terminal state until manually marked failed) —
crash-resume is a Phase-5 step-3 polish item, not a step-2 blocker.
"""
from __future__ import annotations

import asyncio
import logging
import shlex
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from uuid import UUID

from sqlalchemy.orm import Session

from watchtower import cloud_providers as providers_module
from watchtower.api import util
from watchtower.database import (
    CloudProviderCredential,
    OrgNode,
    ProvisioningJob,
    SessionLocal,
)

logger = logging.getLogger(__name__)


# Phase-2 prep script the orchestrator runs on the freshly-booted VM.
# Resolved at import time so the file system isn't hit on every job.
_PREP_SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "prep-node-for-phase2.sh"


# Timeouts. Operator-overridable via env in step 3 if needed.
_WAIT_FOR_READY_SECS = 300   # 5 min — DO + Hetzner typically boot in 30-90s
_SSH_CONNECT_RETRY_SECS = 180  # 3 min — sshd may not be up immediately after status='active'
_POLL_INTERVAL_SECS = 5


# ── State helpers ───────────────────────────────────────────────────────────


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _transition(db: Session, job: ProvisioningJob, status: str, *, error: Optional[str] = None) -> None:
    """Move the job to a new status and persist. Logs the transition
    so an operator tailing the API logs can see exactly when each
    phase fired."""
    logger.info("provisioning: job %s %s → %s%s", job.id, job.status, status, f" ({error})" if error else "")
    job.status = status
    if error is not None:
        job.error = error
    job.updated_at = _now()
    db.commit()


def _mark_failed(db: Session, job: ProvisioningJob, error: str) -> None:
    _transition(db, job, "failed", error=error)


# ── SSH keypair generation ──────────────────────────────────────────────────


def _generate_ssh_keypair() -> tuple[str, str]:
    """Return ``(private_pem, public_openssh)``.

    Ed25519 because it's small, fast, and supported by every modern
    sshd. The public side is OpenSSH single-line format ("ssh-ed25519
    AAAA... watchtower") so the provider's API accepts it as-is.
    """
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    priv = Ed25519PrivateKey.generate()
    pem = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.OpenSSH,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    pub = priv.public_key().public_bytes(
        encoding=serialization.Encoding.OpenSSH,
        format=serialization.PublicFormat.OpenSSH,
    ).decode("ascii")
    # Tag the key so it's identifiable on the provider account list.
    return pem, f"{pub} watchtower"


# ── Stack install + verify (SSH'd into the fresh VM) ────────────────────────
#
# These are the only pieces that touch the live VM. Pulled into named
# functions so step-2 tests can patch them out cleanly — what we want to
# pin in CI is the state machine + cleanup-on-failure, not the SSH
# transport itself (that's the user's real-infra smoke test).


async def _install_stack(public_ipv4: str, private_pem: str, public_openssh: str) -> tuple[bool, str]:
    """SCP the prep script to the VM and run it as root. Returns
    ``(ok, output_or_error)``. SSH waits up to _SSH_CONNECT_RETRY_SECS
    for sshd to answer — provider 'ready' doesn't always mean 'sshd
    accepting connections.'
    """
    if not _PREP_SCRIPT_PATH.exists():
        return False, f"prep script not found at {_PREP_SCRIPT_PATH}"

    import tempfile

    # Write the private key to a temp file with 0600 perms so ssh
    # accepts it. tempfile.NamedTemporaryFile(delete=False) so we can
    # close it before ssh reads it (the windows path / Mac path both
    # work without race).
    keyfile = tempfile.NamedTemporaryFile(prefix="wt-prov-key-", suffix=".pem", delete=False)
    try:
        keyfile.write(private_pem.encode("ascii"))
        keyfile.close()
        Path(keyfile.name).chmod(0o600)

        ssh_opts = [
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ConnectTimeout=10",
            "-i", keyfile.name,
        ]

        # Wait for sshd to answer (up to _SSH_CONNECT_RETRY_SECS).
        deadline = time.monotonic() + _SSH_CONNECT_RETRY_SECS
        while time.monotonic() < deadline:
            probe = await asyncio.create_subprocess_exec(
                "ssh", *ssh_opts, f"root@{public_ipv4}", "true",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            if await probe.wait() == 0:
                break
            await asyncio.sleep(5)
        else:
            return False, f"sshd on {public_ipv4} did not accept connections within {_SSH_CONNECT_RETRY_SECS}s"

        # scp the script.
        scp = await asyncio.create_subprocess_exec(
            "scp", *ssh_opts, str(_PREP_SCRIPT_PATH), f"root@{public_ipv4}:/tmp/prep.sh",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out_bytes, _ = await scp.communicate()
        if scp.returncode != 0:
            return False, f"scp prep script failed: {out_bytes.decode('utf-8', 'replace')}"

        # Run it. The script takes the pubkey as its argument and writes
        # it to the deploy user's authorized_keys.
        run_cmd = f"chmod +x /tmp/prep.sh && /tmp/prep.sh {shlex.quote(public_openssh)}"
        proc = await asyncio.create_subprocess_exec(
            "ssh", *ssh_opts, f"root@{public_ipv4}", run_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out_bytes, _ = await proc.communicate()
        if proc.returncode != 0:
            return False, f"prep script exit {proc.returncode}: {out_bytes.decode('utf-8', 'replace')[-2000:]}"
        return True, out_bytes.decode("utf-8", "replace")
    finally:
        try:
            Path(keyfile.name).unlink(missing_ok=True)
        except Exception:  # pragma: no cover - defensive
            pass


async def _verify_stack(public_ipv4: str, private_pem: str) -> tuple[bool, str]:
    """Confirm the prep script actually completed by running a few
    smoke checks as the unprivileged ``deploy`` user — the same user
    WatchTower will SSH in as from now on. If this passes, the
    operator can deploy to this node immediately."""
    import tempfile

    keyfile = tempfile.NamedTemporaryFile(prefix="wt-prov-verify-", suffix=".pem", delete=False)
    try:
        keyfile.write(private_pem.encode("ascii"))
        keyfile.close()
        Path(keyfile.name).chmod(0o600)

        # Use the deploy user, not root — the script's success is
        # measured by "can the deploy user do its job", not "is root happy".
        checks = " && ".join([
            "podman --version",
            "command -v nginx",
            "test -d /srv/sites",
        ])
        proc = await asyncio.create_subprocess_exec(
            "ssh",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ConnectTimeout=10",
            "-i", keyfile.name,
            f"deploy@{public_ipv4}", checks,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out_bytes, _ = await proc.communicate()
        if proc.returncode != 0:
            return False, f"verify failed (exit {proc.returncode}): {out_bytes.decode('utf-8', 'replace')[-1000:]}"
        return True, "verified"
    finally:
        try:
            Path(keyfile.name).unlink(missing_ok=True)
        except Exception:  # pragma: no cover
            pass


# ── The orchestrator ────────────────────────────────────────────────────────


async def _wait_for_ready(provider: Any, token: str, resource_id: str) -> tuple[bool, Optional[str], str]:
    """Poll ``get_server_status`` until ready or timeout. Returns
    ``(ready, public_ipv4, raw_status)``."""
    deadline = time.monotonic() + _WAIT_FOR_READY_SECS
    last_status = "unknown"
    last_ipv4: Optional[str] = None
    while time.monotonic() < deadline:
        try:
            st = provider.get_server_status(token, resource_id)
        except providers_module.ProviderError as exc:
            logger.warning("provisioning: status poll error: %s", exc.detail)
            await asyncio.sleep(_POLL_INTERVAL_SECS)
            continue
        last_status = st.raw_status
        last_ipv4 = st.public_ipv4 or last_ipv4
        if st.ready and last_ipv4:
            return True, last_ipv4, last_status
        await asyncio.sleep(_POLL_INTERVAL_SECS)
    return False, last_ipv4, last_status


async def _run_provision(job_id: UUID) -> None:
    """The full provision lifecycle for one job. Loads its own DB
    session because it runs detached from the API request handler.
    Designed to never raise — any failure marks the job as ``failed``
    and attempts cleanup."""
    db = SessionLocal()
    try:
        job = db.query(ProvisioningJob).filter(ProvisioningJob.id == job_id).first()
        if not job:
            logger.error("provisioning: job %s not found at run-time", job_id)
            return
        cred = db.query(CloudProviderCredential).filter(
            CloudProviderCredential.id == job.provider_credential_id,
        ).first()
        if not cred:
            _mark_failed(db, job, "credential missing — was it deleted?")
            return

        token = util.decrypt_secret(cred.api_token_encrypted)
        if not token:
            _mark_failed(db, job, "could not decrypt stored token (WATCHTOWER_SECRET_KEY may have rotated)")
            return
        provider = providers_module.get_provider(cred.provider)

        # ── creating_vm ─────────────────────────────────────────────
        _transition(db, job, "creating_vm")
        private_pem, public_openssh = _generate_ssh_keypair()
        try:
            created = provider.create_server(
                token,
                name=job.name,
                region_id=job.region,
                size_id=job.size,
                ssh_public_key=public_openssh,
            )
        except providers_module.ProviderError as exc:
            _mark_failed(db, job, f"create_server failed: {exc.detail}")
            return

        job.provider_resource_id = created.provider_resource_id
        if created.public_ipv4:
            job.public_ipv4 = created.public_ipv4
        db.commit()

        # Everything after this point must attempt cleanup on failure.
        try:
            # ── waiting_for_ready ───────────────────────────────────
            _transition(db, job, "waiting_for_ready")
            ready, ipv4, raw = await _wait_for_ready(provider, token, created.provider_resource_id)
            if not ready:
                _mark_failed(db, job, f"VM did not reach 'ready' within {_WAIT_FOR_READY_SECS}s (last status: {raw})")
                _attempt_cleanup(provider, token, created.provider_resource_id)
                return
            if ipv4:
                job.public_ipv4 = ipv4
                db.commit()

            # ── installing_stack ────────────────────────────────────
            _transition(db, job, "installing_stack")
            ok, msg = await _install_stack(ipv4, private_pem, public_openssh)
            if not ok:
                _mark_failed(db, job, f"prep script: {msg}")
                _attempt_cleanup(provider, token, created.provider_resource_id)
                return

            # ── verifying ───────────────────────────────────────────
            _transition(db, job, "verifying")
            ok, msg = await _verify_stack(ipv4, private_pem)
            if not ok:
                _mark_failed(db, job, f"verify: {msg}")
                _attempt_cleanup(provider, token, created.provider_resource_id)
                return

            # ── registered ──────────────────────────────────────────
            node = OrgNode(
                org_id=job.org_id,
                name=job.name,
                host=ipv4,
                user="deploy",
                port=22,
                remote_path=f"/srv/sites/{job.name}",
                ssh_key_encrypted=util.encrypt_secret(private_pem),
                # Phase 5 tracking — we know how to destroy this node
                # later because we know the provider + resource id.
                provider=cred.provider,
                provider_resource_id=created.provider_resource_id,
                provider_credential_id=cred.id,
                provisioned_at=_now(),
                created_by_user_id=job.created_by_user_id,
            )
            db.add(node)
            db.flush()
            job.node_id = node.id
            _transition(db, job, "registered")
            return

        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("provisioning: unexpected error during job %s", job.id)
            _mark_failed(db, job, f"unexpected error: {exc}")
            _attempt_cleanup(provider, token, created.provider_resource_id)
    finally:
        db.close()


def _attempt_cleanup(provider: Any, token: str, resource_id: str) -> None:
    """Best-effort: try to delete the VM we just created so the operator
    isn't billed for an orphan. Failure here is logged but not surfaced
    — the user-visible job is already 'failed' with a meaningful error."""
    try:
        provider.delete_server(token, resource_id)
        logger.info("provisioning: cleaned up orphan %s on provider", resource_id)
    except Exception:
        logger.exception("provisioning: cleanup of %s failed — operator must delete manually", resource_id)


# ── Public entry point ──────────────────────────────────────────────────────


def enqueue(job: ProvisioningJob) -> None:
    """Spawn the async run loop on the current event loop. Called from
    the API request handler immediately after the job row is created
    so the request returns fast with the job_id, and the UI starts
    polling."""
    loop = asyncio.get_event_loop()
    if loop.is_running():
        loop.create_task(_run_provision(job.id))
    else:
        # If we're not in an async context (e.g., synchronous test
        # entry point), run the coroutine inline. Tests can opt out
        # of this by patching _run_provision directly.
        asyncio.run(_run_provision(job.id))
