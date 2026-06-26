"""Postgres streaming replication for managed databases.

Scope (v1 — single-PC):
  * Postgres only. Other engines have very different replication models
    (MySQL binlog, Mongo oplog/replsets, Redis), so we land Postgres
    correctly first and generalise later.
  * Both pods on the same host. The standby connects to the primary at
    `127.0.0.1:<primary_port>` over the host network.
  * Manual failover only. The endpoint runs `pg_promote()` on the
    standby; the caller is responsible for switching app connection
    strings. Automatic failover with witness quorum is v3.

Scope (v2 — remote standby via Tailscale):
  * `allow_replication_in_pg_hba` now accepts a `remote_cidr` param —
    pass "100.64.0.0/10" to open the Tailscale CGNAT range.
  * `build_remote_standby_compose` generates a docker-compose file the
    user runs on the remote machine (Mac / other Linux PC). The remote
    machine runs `pg_basebackup` on first boot and then streams WAL.
  * `provision_standby` is local-only (v1). Remote provisioning is
    handled by the compose-file handoff — the API surfaces it as a
    downloadable artifact.

The setup flow is delicate, so it's worth spelling out:

1. Make sure the primary is configured for replication:
   - ``wal_level=replica``, ``max_wal_senders``, ``max_replication_slots``
     via `ALTER SYSTEM SET ...`. Persisted in `postgresql.auto.conf`.
   - Restart the primary container so the new GUCs take effect.
2. Create a replication user on the primary (REPLICATION + LOGIN).
3. Create a physical replication slot reserved for this standby — keeps
   WAL on the primary until the standby has applied it, so a brief
   standby outage doesn't break replication.
4. Allow the replication user to connect from 127.0.0.1 in pg_hba.conf.
5. Run `pg_basebackup` from a transient container into the standby's
   data volume. Marks it as a standby (`standby.signal`) and writes
   `primary_conninfo` into the standby's `postgresql.auto.conf`.
6. Start the long-running standby pod. It reads the populated data
   dir, sees `standby.signal`, connects to the primary, and starts
   replaying WAL.

Failure modes we handle:
  * Step 1 fails → primary state unchanged, slot/user not created.
    User retries.
  * Step 4 fails mid-basebackup → orphaned volume + slot. The cleanup
    in `remove_replica` covers both.

Failure modes we do NOT handle in v1:
  * Network partition between primary and standby (single-PC: n/a).
  * Split brain after promotion (we don't fence the old primary
    beyond stopping its container).
  * Data corruption (Postgres' own checksums catch it; we don't add
    application-level CRC).
"""
from __future__ import annotations

import logging
import secrets
import time
from dataclasses import dataclass
from typing import Optional

from watchtower import managed_db_runtime as runtime

logger = logging.getLogger(__name__)


class ReplicationError(Exception):
    """User-facing replication-setup failure."""


# Required Postgres GUC values for a primary serving replication.
# `max_wal_senders` / `max_replication_slots` defaults of 10 are
# generous enough that we don't reconfigure for each new standby —
# tightening to "exactly N" would mean a restart per add.
_PRIMARY_GUCS = (
    ("wal_level", "replica"),
    ("max_wal_senders", "10"),
    ("max_replication_slots", "10"),
    ("hot_standby", "on"),
)

# How long to wait after `podman pod restart` before declaring the
# primary "ready for replication." Postgres typically opens its socket
# in <2s after restart; we poll for it instead of sleeping a fixed
# amount, but cap the wait at this many seconds.
_PRIMARY_READY_TIMEOUT_S = 30


# ── psql exec helpers ────────────────────────────────────────────────────────


def _podman() -> str:
    bin_ = runtime._podman_path()
    if not bin_:
        raise ReplicationError("No container runtime (Podman/Docker) found.")
    return bin_


def _psql_in_container(
    container: str,
    db_user: str,
    db_name: str,
    sql: str,
    *,
    timeout: float = 20.0,
) -> tuple[int, str, str]:
    """Run a SQL statement inside a running container via `podman exec`.

    Used for the post-startup configuration steps that need a live psql
    connection (CREATE USER, CREATE PUBLICATION, pg_promote(), …).
    """
    bin_ = _podman()
    return runtime._run(
        [bin_, "exec", container,
         "psql", "-U", db_user, "-d", db_name, "-tA", "-c", sql],
        timeout=timeout,
    )


def _wait_for_primary_ready(
    container: str, db_user: str, db_name: str, timeout_s: int = _PRIMARY_READY_TIMEOUT_S,
) -> None:
    """Poll the primary's psql endpoint until it answers. Replication
    setup races the restart otherwise."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        rc, out, _err = _psql_in_container(
            container, db_user, db_name, "SELECT 1", timeout=5.0,
        )
        if rc == 0 and "1" in out:
            return
        time.sleep(1.0)
    raise ReplicationError(
        f"Primary container '{container}' did not become ready within {timeout_s}s."
    )


# ── Primary configuration ────────────────────────────────────────────────────


def configure_primary_for_replication(
    primary_container: str, primary_user: str, primary_db: str,
) -> None:
    """Set the GUCs needed for streaming replication and restart the
    primary so they take effect. Idempotent — re-running is safe.

    Why we restart unconditionally: the GUCs we set
    (``wal_level``, ``max_wal_senders``) require a restart, not a
    reload. Skipping the restart "to be efficient" leaves the primary
    in an inconsistent state where the configuration LOOKS right but
    isn't loaded — and the first basebackup attempt fails with a
    misleading "WAL streaming requires wal_level >= replica" error.
    """
    for guc, value in _PRIMARY_GUCS:
        rc, _out, err = _psql_in_container(
            primary_container, primary_user, primary_db,
            f"ALTER SYSTEM SET {guc} = '{value}'",
        )
        if rc != 0:
            raise ReplicationError(
                f"Failed to set {guc} on primary: {err.strip() or 'unknown error'}"
            )

    bin_ = _podman()
    # Pod-level restart so all sidecars (in v1 there's only the DB
    # container, but the abstraction matters for v2's exporter sidecars).
    pod_for_container = primary_container.replace("-pg", "")
    rc, _out, err = runtime._run(
        [bin_, "pod", "restart", pod_for_container],
        timeout=60.0,
    )
    if rc != 0:
        raise ReplicationError(
            f"Failed to restart primary pod for new GUCs: {err.strip() or 'unknown error'}"
        )

    _wait_for_primary_ready(primary_container, primary_user, primary_db)


def create_replication_user(
    primary_container: str, primary_user: str, primary_db: str,
    repl_user: str, repl_password: str,
) -> None:
    """Create the replication-only role. Skips if it already exists so
    re-running this whole flow after a partial failure is safe."""
    # Quote password defensively — random tokens shouldn't contain
    # single quotes but a future bring-your-own-password feature might.
    safe_pw = repl_password.replace("'", "''")
    sql = (
        f"DO $$ BEGIN "
        f"  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='{repl_user}') THEN "
        f"    CREATE ROLE {repl_user} WITH REPLICATION LOGIN PASSWORD '{safe_pw}'; "
        f"  ELSE "
        f"    ALTER ROLE {repl_user} WITH REPLICATION LOGIN PASSWORD '{safe_pw}'; "
        f"  END IF; "
        f"END $$;"
    )
    rc, _out, err = _psql_in_container(primary_container, primary_user, primary_db, sql)
    if rc != 0:
        raise ReplicationError(
            f"Failed to create replication user: {err.strip() or 'unknown error'}"
        )


def create_replication_slot(
    primary_container: str, primary_user: str, primary_db: str, slot_name: str,
) -> None:
    """Create a physical replication slot. Idempotent.

    Slots are critical: without one, the primary discards WAL the
    standby hasn't replayed if the standby briefly disconnects, and
    replication breaks until a fresh basebackup. With the slot, the
    primary retains WAL until the standby acknowledges it (with the
    cost that an offline standby pins WAL forever — operationally
    important but accepted in v1).
    """
    sql = (
        f"SELECT pg_create_physical_replication_slot('{slot_name}') "
        f"WHERE NOT EXISTS ("
        f"  SELECT 1 FROM pg_replication_slots WHERE slot_name = '{slot_name}'"
        f")"
    )
    rc, _out, err = _psql_in_container(primary_container, primary_user, primary_db, sql)
    if rc != 0:
        raise ReplicationError(
            f"Failed to create replication slot: {err.strip() or 'unknown error'}"
        )


def allow_replication_in_pg_hba(
    primary_container: str,
    remote_cidr: str | None = None,
) -> None:
    """Append `host replication` rules to pg_hba.conf and reload.

    Idempotent — checks for a sentinel comment before appending.

    Args:
        primary_container: Running Postgres container name.
        remote_cidr: Extra CIDR to allow in addition to loopback —
            pass ``"100.64.0.0/10"`` (Tailscale CGNAT range) when
            provisioning a remote standby on another machine in the
            tailnet.
    """
    bin_ = _podman()
    sentinel = "# watchtower-managed-db replication rule"
    extra = ""
    if remote_cidr:
        extra = (
            f"  echo '# watchtower remote standby via Tailscale' "
            f">> /var/lib/postgresql/data/pg_hba.conf; "
            f"  echo 'host replication all {remote_cidr} scram-sha-256' "
            f">> /var/lib/postgresql/data/pg_hba.conf; "
        )
    sql_check = (
        f"if ! grep -q '{sentinel}' /var/lib/postgresql/data/pg_hba.conf; then "
        f"  echo '{sentinel}' >> /var/lib/postgresql/data/pg_hba.conf; "
        f"  echo 'host replication all 127.0.0.1/32 md5' >> /var/lib/postgresql/data/pg_hba.conf; "
        f"  echo 'host replication all ::1/128 md5' >> /var/lib/postgresql/data/pg_hba.conf; "
        f"{extra}"
        f"fi"
    )
    rc, _out, err = runtime._run(
        [bin_, "exec", primary_container, "sh", "-c", sql_check],
        timeout=15.0,
    )
    if rc != 0:
        raise ReplicationError(
            f"Failed to update pg_hba.conf on primary: {err.strip() or 'unknown error'}"
        )

    # Reload — pg_hba.conf changes don't require a restart.
    rc, _out, err = _psql_in_container(
        primary_container, "postgres", "postgres",
        "SELECT pg_reload_conf()",
    )
    if rc != 0:
        logger.warning(
            "Failed to reload primary pg_hba: %s. Replication will work "
            "after the next primary restart.", err.strip()
        )


# ── Standby provisioning ─────────────────────────────────────────────────────


@dataclass
class StandbySpec:
    replica_id: str
    image: str                # SAME image as the primary (otherwise WAL format mismatches)
    primary_host: str         # 127.0.0.1 in v1
    primary_port: int
    replica_port: int         # host-exposed port for the standby
    repl_user: str
    repl_password: str
    slot_name: str
    primary_data_path: str = "/var/lib/postgresql/data"


def provision_standby(spec: StandbySpec) -> tuple[str, str, str]:
    """Create the standby pod + container, populate its volume via
    pg_basebackup, and start it as a streaming standby. Returns
    (pod_name, container_name, volume_name) so the caller can persist
    them on the ManagedDatabaseReplica row.

    Implementation choice: we run `pg_basebackup` as a one-shot
    container that writes into the *named volume* that the long-running
    standby will then mount. This avoids the "container is running but
    PGDATA isn't initialised" race that bites you if you try to
    bootstrap-then-replace inside a single container.
    """
    bin_ = _podman()

    pod = runtime.pod_name(spec.replica_id)
    container = runtime.container_name(spec.replica_id)
    volume = runtime.volume_name(spec.replica_id)

    # Clean up any debris from prior partial attempts.
    runtime._run([bin_, "pod", "rm", "-f", pod], timeout=30.0)
    runtime._run([bin_, "volume", "rm", "-f", volume], timeout=15.0)
    runtime._run([bin_, "volume", "create", volume], timeout=10.0)

    # ── Step 1: run pg_basebackup into the volume ─────────────────
    # `pg_basebackup -R` writes both `standby.signal` and the
    # `primary_conninfo` line into `postgresql.auto.conf` for us — much
    # less error-prone than constructing those files by hand.
    rc, out, err = runtime._run(
        [bin_, "run", "--rm",
         "--network", "host",
         "-e", f"PGPASSWORD={spec.repl_password}",
         "-v", f"{volume}:{spec.primary_data_path}",
         spec.image,
         "pg_basebackup",
         "-h", spec.primary_host,
         "-p", str(spec.primary_port),
         "-U", spec.repl_user,
         "-D", spec.primary_data_path,
         "-S", spec.slot_name,
         "-X", "stream",
         "-R",   # auto-write standby.signal + primary_conninfo
         "-P",   # progress reporting in logs (useful for big primaries)
         ],
        timeout=600.0,  # base backup of a large DB can take a while
    )
    if rc != 0:
        # Clean up the partial volume so the next retry starts fresh.
        runtime._run([bin_, "volume", "rm", "-f", volume], timeout=15.0)
        raise ReplicationError(
            f"pg_basebackup failed: {err.strip() or out.strip() or 'unknown error'}"
        )

    # ── Step 2: create the standby pod ─────────────────────────────
    rc, _out, err = runtime._run(
        [bin_, "pod", "create",
         "--name", pod,
         "-p", f"127.0.0.1:{spec.replica_port}:5432"],
        timeout=20.0,
    )
    if rc != 0:
        runtime._run([bin_, "volume", "rm", "-f", volume], timeout=15.0)
        raise ReplicationError(
            f"Failed to create standby pod: {err.strip() or 'unknown error'}"
        )

    # ── Step 3: start the standby container ────────────────────────
    # The container reads PGDATA from the populated volume. Postgres'
    # entrypoint sees a non-empty PGDATA + standby.signal and starts
    # in standby mode automatically.
    rc, _out, err = runtime._run(
        [bin_, "run", "-d",
         "--pod", pod,
         "--name", container,
         "--restart", "unless-stopped",
         # We don't pass POSTGRES_* env vars on the standby — those
         # are only meaningful when the entrypoint does initdb, which
         # doesn't happen on a pre-populated PGDATA.
         "-v", f"{volume}:{spec.primary_data_path}",
         spec.image],
        timeout=60.0,
    )
    if rc != 0:
        runtime._run([bin_, "pod", "rm", "-f", pod], timeout=30.0)
        runtime._run([bin_, "volume", "rm", "-f", volume], timeout=15.0)
        raise ReplicationError(
            f"Failed to start standby container: {err.strip() or 'unknown error'}"
        )

    return pod, container, volume


# ── Remote standby (v2 — Tailscale compose handoff) ──────────────────────────

def build_remote_standby_init_script() -> str:
    """Return the shell init script that goes alongside the compose file.

    On first boot (empty PGDATA) it runs ``pg_basebackup`` from the primary
    over Tailscale, then starts Postgres in standby mode.  On subsequent
    restarts it just starts Postgres directly.
    """
    return """\
#!/bin/sh
# WatchTower-generated init script for a remote Postgres streaming standby.
# Save alongside docker-compose.standby.yml, chmod +x, then: docker compose up -d
set -e

if [ -z "$(ls -A "$PGDATA")" ]; then
    echo "[wt-standby] PGDATA empty — running pg_basebackup from $PRIMARY_HOST:$PRIMARY_PORT ..."
    PGPASSWORD="$REPL_PASSWORD" pg_basebackup \\
        -h "$PRIMARY_HOST" \\
        -p "$PRIMARY_PORT" \\
        -U "$REPL_USER" \\
        -D "$PGDATA" \\
        -S "$SLOT_NAME" \\
        -X stream \\
        -R \\
        -P
    echo "[wt-standby] pg_basebackup complete — starting standby ..."
fi

exec docker-entrypoint.sh postgres
"""


def build_remote_standby_compose(
    primary_tailscale_ip: str,
    primary_port: int,
    repl_user: str,
    repl_password: str,
    slot_name: str,
    image: str,
    replica_port: int = 5433,
) -> str:
    """Return a docker-compose YAML string for a remote Postgres standby.

    The caller packages this with :func:`build_remote_standby_init_script`
    into a zip the user downloads and runs on the remote machine::

        chmod +x init-standby.sh
        docker compose -f docker-compose.standby.yml up -d

    On first boot the init script runs ``pg_basebackup`` against the primary
    via Tailscale, then starts Postgres in standby mode.  On subsequent
    restarts it just starts Postgres directly.
    """
    lines = [
        "# WatchTower-generated remote standby compose file.",
        f"# Primary Tailscale IP: {primary_tailscale_ip}:{primary_port}",
        f"# Replication slot: {slot_name}",
        "#",
        "# 1. Save alongside init-standby.sh",
        "# 2. chmod +x init-standby.sh",
        "# 3. docker compose -f docker-compose.standby.yml up -d",
        "",
        'version: "3.9"',
        "",
        "services:",
        "  standby:",
        f"    image: {image}",
        "    container_name: wt-standby",
        "    restart: unless-stopped",
        "    ports:",
        f'      - "{replica_port}:5432"',
        "    volumes:",
        "      - standby-data:/var/lib/postgresql/data",
        "      - ./init-standby.sh:/init-standby.sh:ro",
        '    entrypoint: ["/bin/sh", "/init-standby.sh"]',
        "    environment:",
        "      PGDATA: /var/lib/postgresql/data",
        f"      PRIMARY_HOST: {primary_tailscale_ip}",
        f'      PRIMARY_PORT: "{primary_port}"',
        f"      REPL_USER: {repl_user}",
        f"      REPL_PASSWORD: {repl_password}",
        f"      SLOT_NAME: {slot_name}",
        "",
        "volumes:",
        "  standby-data:",
    ]
    return "\n".join(lines) + "\n"


# ── Failover ─────────────────────────────────────────────────────────────────


def promote_standby(replica_container: str, replica_user: str, replica_db: str) -> None:
    """Promote a streaming standby to primary via `pg_promote()`.

    `pg_promote()` is the Postgres-blessed way to do this — sends
    SIGUSR1 to the WAL receiver, which finishes replay and reopens
    in read-write mode. Returns when the standby has fully promoted
    or the wait timeout (60s by default) elapses.
    """
    rc, out, err = _psql_in_container(
        replica_container, replica_user, replica_db,
        "SELECT pg_promote(true, 60)",
        timeout=80.0,
    )
    if rc != 0:
        raise ReplicationError(
            f"pg_promote() failed: {err.strip() or 'unknown error'}"
        )
    # pg_promote returns 't' or 'f' as text; 'f' means it timed out
    # without completing promotion.
    if "t" not in out.lower():
        raise ReplicationError(
            "pg_promote() returned false — standby did not finish promotion within the timeout. "
            "It may still complete; check status before retrying."
        )


def stop_container_best_effort(container: str) -> None:
    """Stop a container without raising on failure. Used post-failover
    to fence the old primary so it can't accept writes. Best-effort
    because if the container's already gone we don't care."""
    bin_ = runtime._podman_path()
    if not bin_:
        return
    runtime._run([bin_, "stop", container], timeout=30.0)


# ── Misc helpers ─────────────────────────────────────────────────────────────


def generate_slot_name(replica_id: str) -> str:
    """Postgres replication slot names must be `[a-z0-9_]{1,64}`. Mash
    the UUID into a deterministic legal name."""
    cleaned = replica_id.replace("-", "_").lower()[:50]
    return f"wt_repl_{cleaned}"


def generate_replication_password() -> str:
    """URL-safe so it survives a stray shell-interpolation later
    (we still quote in SQL); long enough that brute force is moot."""
    return secrets.token_urlsafe(32)


def build_remote_standby_compose(
    *,
    primary_tailscale_ip: str,
    primary_port: int,
    repl_user: str,
    repl_password: str,
    slot_name: str,
    image: str,
    replica_port: int = 5432,
) -> str:
    """Return a docker-compose YAML string the user runs on the remote machine.

    The generated compose uses an init script that:
      1. Waits for the primary to be reachable via Tailscale.
      2. Runs pg_basebackup -R (writes standby.signal + primary_conninfo).
      3. Hands off to the normal postgres entrypoint (which starts in standby mode).

    The caller is responsible for surfacing this to the user (download
    endpoint, copy-to-clipboard, etc.).
    """
    init_script = (
        "#!/bin/bash\\n"
        "set -e\\n"
        "if [ -z \\\"$(ls -A \\$PGDATA)\\\" ]; then\\n"
        "  echo 'Standby: waiting for primary...'\\n"
        "  until pg_isready -h \\\"\\$PRIMARY_HOST\\\" -p \\\"\\$PRIMARY_PORT\\\" 2>/dev/null; do\\n"
        "    sleep 2\\n"
        "  done\\n"
        "  echo 'Standby: running pg_basebackup...'\\n"
        "  PGPASSWORD=\\\"\\$REPLICATION_PASSWORD\\\" pg_basebackup \\\\\\n"
        "    -h \\\"\\$PRIMARY_HOST\\\" -p \\\"\\$PRIMARY_PORT\\\" \\\\\\n"
        "    -U \\\"\\$REPLICATION_USER\\\" \\\\\\n"
        "    -D \\\"\\$PGDATA\\\" -S \\\"\\$SLOT_NAME\\\" \\\\\\n"
        "    -X stream -R -P\\n"
        "  echo 'Standby: base backup complete.'\\n"
        "fi\\n"
    )
    return f"""version: "3.9"
# WatchTower-generated standby compose — run on the remote machine.
# Primary: {primary_tailscale_ip}:{primary_port}
# Replication slot: {slot_name}
#
# Steps:
#   1. Make sure Tailscale is connected on this machine.
#   2. Copy this file and the init script to the remote machine.
#   3. Run: docker compose -f docker-compose.standby.yml up -d

services:
  postgres-standby:
    image: {image}
    container_name: watchtower-standby-{slot_name[:16]}
    restart: unless-stopped
    ports:
      - "{replica_port}:5432"
    environment:
      POSTGRES_PASSWORD: standby_local_only
      PGDATA: /var/lib/postgresql/data
      PRIMARY_HOST: {primary_tailscale_ip}
      PRIMARY_PORT: "{primary_port}"
      REPLICATION_USER: {repl_user}
      REPLICATION_PASSWORD: {repl_password}
      SLOT_NAME: {slot_name}
    volumes:
      - standby_data:/var/lib/postgresql/data
      - ./init-standby.sh:/docker-entrypoint-initdb.d/init-standby.sh
    healthcheck:
      test: ["CMD-SHELL", "pg_isready"]
      interval: 15s
      timeout: 5s
      retries: 5

volumes:
  standby_data:
    name: watchtower-standby-{slot_name[:16]}
"""


def build_remote_standby_init_script() -> str:
    """Return the init-standby.sh content to place alongside the compose file."""
    return """#!/bin/bash
set -e
if [ -z "$(ls -A "$PGDATA")" ]; then
  echo "Standby: waiting for primary at $PRIMARY_HOST:$PRIMARY_PORT..."
  until pg_isready -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" 2>/dev/null; do
    sleep 2
  done
  echo "Standby: running pg_basebackup..."
  PGPASSWORD="$REPLICATION_PASSWORD" pg_basebackup \\
    -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" \\
    -U "$REPLICATION_USER" \\
    -D "$PGDATA" -S "$SLOT_NAME" \\
    -X stream -R -P
  echo "Standby: base backup complete, streaming replication configured."
fi
"""


def drop_replication_slot_best_effort(
    primary_container: str, primary_user: str, primary_db: str, slot_name: str,
) -> None:
    """Drop the replication slot when removing a standby. Best-effort
    because if the standby is the slot's only consumer and never
    reconnected, dropping might fail; that's recoverable manually."""
    _psql_in_container(
        primary_container, primary_user, primary_db,
        # `pg_drop_replication_slot` errors if the slot is in use; the
        # outer query returns NULL in that case so the call doesn't
        # fail the API request.
        f"SELECT CASE WHEN active "
        f"  THEN NULL "
        f"  ELSE pg_drop_replication_slot('{slot_name}') END "
        f"FROM pg_replication_slots WHERE slot_name = '{slot_name}'",
    )
