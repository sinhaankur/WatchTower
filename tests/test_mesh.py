"""Tests for the SWIM gossip mesh (watchtower/mesh.py) and auto-failover.

The state machine and wire framing are pure/socket-free by design, so these
tests drive them directly and deterministically — no sockets, no sleeps, no
network flake. Covers the load-bearing SWIM invariants:

  * incarnation ordering (higher always wins; equal only goes "more dead")
  * self-refutation of a wrong SUSPECT/DEAD rumor
  * suspicion-timeout promotion SUSPECT -> DEAD
  * gossip piggyback budget + merge
  * HMAC datagram auth (accept valid, reject tampered / wrong-key / malformed)
  * failover promotion decision (role/toggle/quorum guards)
"""
from __future__ import annotations

import watchtower.mesh as mesh
from watchtower.mesh import (
    MeshState,
    MemberState,
    encode_datagram,
    decode_datagram,
)


SELF = "10.0.0.1:7946"
PEER = "10.0.0.2:7946"
PEER3 = "10.0.0.3:7946"


def _state() -> MeshState:
    s = MeshState(self_addr=SELF, self_name="node-a")
    s.add_peer(PEER, "node-b")
    return s


# ── incarnation ordering ─────────────────────────────────────────────────────

def test_higher_incarnation_wins():
    s = _state()
    assert s.apply_update(PEER, "suspect", 0) is True
    assert s.members[PEER].state == MemberState.SUSPECT
    # Higher incarnation ALIVE refutes the suspicion.
    assert s.apply_update(PEER, "alive", 1) is True
    assert s.members[PEER].state == MemberState.ALIVE
    assert s.members[PEER].incarnation == 1


def test_stale_incarnation_is_ignored():
    s = _state()
    s.apply_update(PEER, "alive", 5)
    # An older-incarnation suspicion must not override a newer ALIVE.
    assert s.apply_update(PEER, "suspect", 3) is False
    assert s.members[PEER].state == MemberState.ALIVE


def test_equal_incarnation_only_goes_more_dead():
    s = _state()
    s.apply_update(PEER, "alive", 2)
    # Same incarnation: suspect overrides alive.
    assert s.apply_update(PEER, "suspect", 2) is True
    assert s.members[PEER].state == MemberState.SUSPECT
    # Same incarnation: alive does NOT override suspect (needs higher inc).
    assert s.apply_update(PEER, "alive", 2) is False
    assert s.members[PEER].state == MemberState.SUSPECT
    # Same incarnation: dead overrides suspect.
    assert s.apply_update(PEER, "dead", 2) is True
    assert s.members[PEER].state == MemberState.DEAD


# ── self-refutation ──────────────────────────────────────────────────────────

def test_self_refutes_suspicion_by_bumping_incarnation():
    s = _state()
    assert s.incarnation == 0
    # A rumor that WE are suspect → we bump our incarnation above it and win.
    assert s.apply_update(SELF, "suspect", 0) is True
    assert s.incarnation == 1
    # Our refutation is queued for gossip as an ALIVE about ourselves.
    drained = s.drain_gossip()
    self_alive = [g for g in drained if g["addr"] == SELF and g["state"] == "alive"]
    assert self_alive and self_alive[0]["incarnation"] == 1


def test_self_ignores_stale_suspicion():
    s = _state()
    s.incarnation = 5
    # A suspicion at a lower incarnation than ours is already refuted — no-op.
    assert s.apply_update(SELF, "suspect", 2) is False
    assert s.incarnation == 5


# ── suspicion timeout → dead ─────────────────────────────────────────────────

def test_suspect_expires_to_dead_after_window(monkeypatch):
    s = _state()
    s.mark_suspect(PEER)
    assert s.members[PEER].state == MemberState.SUSPECT
    # Not yet expired.
    assert s.expire_suspects(now=s.members[PEER].state_since + 0.1) == []
    # After the suspicion window it flips to DEAD and is returned.
    window = mesh.SUSPICION_MULT * mesh.PROTOCOL_PERIOD
    dead = s.expire_suspects(now=s.members[PEER].state_since + window + 0.01)
    assert dead == [PEER]
    assert s.members[PEER].state == MemberState.DEAD


def test_ack_clears_suspicion():
    s = _state()
    s.mark_suspect(PEER)
    assert s.members[PEER].state == MemberState.SUSPECT
    assert s.mark_alive_from_ack(PEER) is True
    assert s.members[PEER].state == MemberState.ALIVE


# ── gossip piggyback ─────────────────────────────────────────────────────────

def test_gossip_has_send_budget_then_stops():
    s = _state()  # adding PEER queued one gossip item
    s._gossip.clear()
    s.apply_update(PEER3, "alive", 0)  # queues one item, budget = GOSSIP_FANOUT
    seen = 0
    for _ in range(mesh.GOSSIP_FANOUT + 3):
        items = s.drain_gossip()
        if any(i["addr"] == PEER3 for i in items):
            seen += 1
    assert seen == mesh.GOSSIP_FANOUT  # exactly the budget, no more


def test_ingest_gossip_learns_new_peer():
    s = _state()
    changed = s.ingest_gossip([
        {"addr": PEER3, "state": "alive", "incarnation": 0, "name": "node-c"},
    ])
    assert changed is True
    assert PEER3 in s.members
    assert s.members[PEER3].name == "node-c"


def test_ingest_ignores_dead_rumor_about_unknown_peer():
    s = _state()
    # We shouldn't resurrect-then-bury a peer we never knew from a DEAD rumor.
    assert s.ingest_gossip([{"addr": "10.9.9.9:7946", "state": "dead", "incarnation": 3}]) is False
    assert "10.9.9.9:7946" not in s.members


# ── HMAC datagram framing ────────────────────────────────────────────────────

def test_encode_decode_roundtrip():
    secret = b"shared-secret"
    payload = {"type": "ping", "from": SELF, "gossip": []}
    raw = encode_datagram(payload, secret=secret)
    assert decode_datagram(raw, secret=secret) == payload


def test_decode_rejects_tampered_body():
    secret = b"shared-secret"
    raw = encode_datagram({"type": "ping"}, secret=secret)
    tag, body = raw.split(b".", 1)
    tampered = tag + b"." + body.replace(b"ping", b"pong")
    assert decode_datagram(tampered, secret=secret) is None


def test_decode_rejects_wrong_key():
    raw = encode_datagram({"type": "ping"}, secret=b"key-a")
    assert decode_datagram(raw, secret=b"key-b") is None


def test_decode_rejects_malformed():
    assert decode_datagram(b"not-a-datagram", secret=b"k") is None
    assert decode_datagram(b"", secret=b"k") is None
    # Valid HMAC framing but non-JSON body.
    import hashlib, hmac as _hmac
    body = b"\xff\xfe not json"
    tag = _hmac.new(b"k", body, hashlib.sha256).hexdigest().encode()
    assert decode_datagram(tag + b"." + body, secret=b"k") is None


def test_self_is_never_added_as_peer():
    s = _state()
    s.add_peer(SELF, "me")
    assert SELF not in s.members


# ── probe target selection ───────────────────────────────────────────────────

def test_random_probe_skips_dead():
    s = _state()
    s.apply_update(PEER, "dead", 1)
    s.apply_update(PEER3, "alive", 0)
    # PEER is dead → only PEER3 is a valid probe target.
    for _ in range(10):
        assert s.random_probe_target() == PEER3


def test_snapshot_includes_self_and_peers():
    s = _state()
    snap = s.snapshot()
    addrs = {row["addr"]: row for row in snap}
    assert addrs[SELF]["self"] is True
    assert addrs[PEER]["self"] is False


# ── failover decision logic ──────────────────────────────────────────────────

def test_failover_noop_when_not_standby(monkeypatch):
    """A primary/standalone node never promotes on a peer death."""
    from watchtower import failover
    from watchtower.api import this_pc

    calls = {"promoted": False}

    class _FakeDB:
        def commit(self): pass
        def close(self): pass

    monkeypatch.setattr("watchtower.database.SessionLocal", lambda: _FakeDB())

    def _get_setting(db, key):
        if key == this_pc._ROLE_KEY:
            return "primary"   # not a standby
        return None
    monkeypatch.setattr("watchtower.llm_settings.get_setting", _get_setting)
    monkeypatch.setattr("watchtower.llm_settings.set_setting",
                        lambda *a, **k: calls.__setitem__("promoted", True))

    failover._maybe_failover(PEER)
    assert calls["promoted"] is False


def test_failover_noop_when_toggle_off(monkeypatch):
    from watchtower import failover
    from watchtower.api import this_pc

    promoted = {"v": False}

    class _FakeDB:
        def commit(self): pass
        def close(self): pass
    monkeypatch.setattr("watchtower.database.SessionLocal", lambda: _FakeDB())

    def _get_setting(db, key):
        if key == this_pc._ROLE_KEY:
            return "standby"
        if key == failover.AUTO_FAILOVER_KEY:
            return "false"  # toggle OFF
        return None
    monkeypatch.setattr("watchtower.llm_settings.get_setting", _get_setting)
    monkeypatch.setattr("watchtower.llm_settings.set_setting",
                        lambda *a, **k: promoted.__setitem__("v", True))

    failover._maybe_failover(PEER)
    assert promoted["v"] is False


def test_quorum_guard_blocks_solo_partition(monkeypatch):
    """A standby that sees the primary dead but has no other alive peers must
    NOT promote (it might be the partitioned one) unless ALLOW_SOLO is set."""
    from watchtower import failover

    class _FakeMember:
        def __init__(self, addr, state):
            self.addr = addr
            self.state = type("S", (), {"value": state})()

    class _FakeState:
        members = {PEER: _FakeMember(PEER, "dead")}

    class _FakeDaemon:
        state = _FakeState()

    monkeypatch.setattr(mesh, "get_daemon", lambda: _FakeDaemon())
    monkeypatch.delenv("WATCHTOWER_FAILOVER_ALLOW_SOLO", raising=False)
    assert failover._quorum_confirms_dead(PEER) is False

    # With a healthy other peer, quorum is satisfied.
    _FakeState.members = {
        PEER: _FakeMember(PEER, "dead"),
        PEER3: _FakeMember(PEER3, "alive"),
    }
    assert failover._quorum_confirms_dead(PEER) is True


# ── HTTP endpoints ───────────────────────────────────────────────────────────

def test_mesh_status_endpoint_when_not_running(client):
    """On a node with no tailnet the mesh isn't running — endpoint still 200s
    with a clear not-running shape rather than erroring."""
    r = client.get("/api/this-pc/mesh")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["running"] is False
    assert body["members"] == []


def _bootstrap_owner(client):
    """Force the static-token caller into an OWNER TeamMember row (needed by the
    can_manage_team gate). Creating a project runs _ensure_user_org_member."""
    r = client.post("/api/projects", json={
        "name": "mesh-bootstrap", "use_case": "vercel_like",
        "repo_url": "https://example.com/x.git", "repo_branch": "main",
    })
    assert r.status_code == 201, r.text


def test_failover_toggle_endpoint_round_trips(client):
    """The auto-failover switch persists and surfaces in control-plane status."""
    _bootstrap_owner(client)
    r = client.put("/api/this-pc/control-plane/failover", json={"enabled": True})
    assert r.status_code == 200, r.text
    assert r.json()["auto_failover_enabled"] is True

    cp = client.get("/api/this-pc/control-plane")
    assert cp.status_code == 200, cp.text
    assert cp.json()["auto_failover_enabled"] is True

    # Toggle back off.
    r2 = client.put("/api/this-pc/control-plane/failover", json={"enabled": False})
    assert r2.json()["auto_failover_enabled"] is False


# ── gossip state-sync (version signal → instant pull) ────────────────────────

def test_datagram_carries_state_version():
    """The daemon stamps its state version onto every outgoing datagram."""
    from watchtower.mesh import MeshDaemon, decode_datagram

    d = MeshDaemon("10.0.0.1:7946", "a")
    d.set_version_provider(lambda: 99)
    sent = {}

    class _T:
        def sendto(self, data, dest):
            sent["payload"] = decode_datagram(data)
    d._transport = _T()
    d.state.add_peer("10.0.0.2:7946", "b")
    d._send("10.0.0.2:7946", list(mesh.MsgType)[0])
    assert sent["payload"]["sv"] == 99


def test_observe_version_fires_only_on_advance():
    from watchtower.mesh import MeshDaemon

    d = MeshDaemon(SELF, "a")
    d.state.add_peer(PEER, "b")
    fired = []
    d.on_version(lambda addr, v: fired.append((addr, v)))
    d._observe_version(PEER, 5)   # 0 -> 5 : fires
    d._observe_version(PEER, 5)   # equal  : no
    d._observe_version(PEER, 3)   # lower  : no
    d._observe_version(PEER, 8)   # 5 -> 8 : fires
    d._observe_version("10.9.9.9:7946", 100)  # unknown peer : no
    assert fired == [(PEER, 5), (PEER, 8)]


def test_observe_version_ignores_zero():
    from watchtower.mesh import MeshDaemon

    d = MeshDaemon(SELF, "a")
    d.state.add_peer(PEER, "b")
    fired = []
    d.on_version(lambda addr, v: fired.append(v))
    d._observe_version(PEER, 0)   # a peer with no state version (not a primary)
    assert fired == []


def test_current_state_version_is_monotonic(client, db_session):
    """The derived version rises as audit rows accumulate (never decreases)."""
    from watchtower import control_plane_sync as cps

    v0 = cps.current_state_version(db_session)
    # Any mutating call writes an audit row → version must not go down.
    client.post("/api/projects", json={
        "name": "sv-bump", "use_case": "vercel_like",
        "repo_url": "https://example.com/x.git", "repo_branch": "main",
    })
    v1 = cps.current_state_version(db_session)
    assert v1 >= v0


def test_on_primary_version_pulls_only_for_paired_primary(monkeypatch):
    """A version bump from our primary triggers a pull; from anyone else it
    doesn't; and only when the version actually advances."""
    from watchtower import control_plane_sync as cps
    from watchtower.api import this_pc

    settings = {this_pc._ROLE_KEY: "standby", this_pc._PEER_HOST_KEY: "10.0.0.2"}

    class _FakeDB:
        def close(self): pass
    monkeypatch.setattr("watchtower.database.SessionLocal", lambda: _FakeDB())
    monkeypatch.setattr("watchtower.llm_settings.get_setting",
                        lambda db, k: settings.get(k))
    monkeypatch.setattr(cps, "last_synced_version", lambda db=None: 10)

    pulls = []
    monkeypatch.setattr(cps, "sync_now", lambda: (pulls.append(cps._pending_target_version.get("v")) or (True, "ok")))
    cps._last_triggered_at.clear()

    # Newer version from our primary (10.0.0.2) → pulls.
    cps.on_primary_version("10.0.0.2:7946", 12)
    assert pulls == [12]

    # A different peer bumping → ignored (debounce cleared so that's not why).
    cps._last_triggered_at.clear()
    cps.on_primary_version("10.9.9.9:7946", 99)
    assert pulls == [12]

    # Same/older version from primary → no re-pull (<= last_synced 10 handled,
    # but even at 11 the debounce+advance guards apply; assert not-advanced case).
    cps._last_triggered_at.clear()
    cps.on_primary_version("10.0.0.2:7946", 10)   # not > last_synced 10
    assert pulls == [12]


def test_on_primary_version_debounces(monkeypatch):
    from watchtower import control_plane_sync as cps
    from watchtower.api import this_pc

    settings = {this_pc._ROLE_KEY: "standby", this_pc._PEER_HOST_KEY: "10.0.0.2"}

    class _FakeDB:
        def close(self): pass
    monkeypatch.setattr("watchtower.database.SessionLocal", lambda: _FakeDB())
    monkeypatch.setattr("watchtower.llm_settings.get_setting",
                        lambda db, k: settings.get(k))
    monkeypatch.setattr(cps, "last_synced_version", lambda db=None: 0)
    monkeypatch.setenv("WATCHTOWER_CP_SYNC_DEBOUNCE_SECS", "999")

    pulls = []
    monkeypatch.setattr(cps, "sync_now", lambda: (pulls.append(1) or (True, "ok")))
    cps._last_triggered_at.clear()

    cps.on_primary_version("10.0.0.2:7946", 5)
    cps.on_primary_version("10.0.0.2:7946", 6)  # within debounce window → skipped
    assert pulls == [1]
