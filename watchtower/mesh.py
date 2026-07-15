"""SWIM-style gossip membership for the WatchTower node mesh.

Gives every node a live, weakly-consistent view of *which nodes are up right
now* — the piece missing from the rest of the HA stack, which re-derives
liveness by polling (see ``control_plane_sync.py``). Based on:

  * Das, Gupta, Motivala, "SWIM: Scalable Weakly-consistent Infection-style
    Process Group Membership Protocol", IEEE DSN 2002.
  * Dadgar et al., "Lifeguard" extensions (suspicion timeout + local health).

See ``docs/RESEARCH_IDEAS.md`` for the design rationale.

Design
------
Two components, exactly as in the paper:

  * **Failure detector** — each protocol period ``T`` a node direct-pings one
    random peer. No ack within a short window → it asks ``k`` other random peers
    to *indirect*-ping the target (``ping-req``). Only if BOTH the direct probe
    and all indirect probes come back silent does the target become *suspect*.
    This is what stops one flaky A→B link from declaring B dead.

  * **Dissemination** — membership deltas ride piggybacked on the ping/ack/
    ping-req datagrams themselves (``gossip`` field). No separate multicast.

State machine per member: ``ALIVE -> SUSPECT -> DEAD``. A SUSPECT node has a
gossip window (``SUSPICION_MULT * T``) to *refute* by bumping its own
**incarnation** number; the higher incarnation always wins, so a live node
wrongly suspected re-asserts itself and everyone converges back to ALIVE.

Transport
---------
UDP datagrams between peers' **Tailscale IPs** (the tailnet is already
WireGuard-encrypted). Every datagram is authenticated with an HMAC-SHA256 tag
keyed by ``WATCHTOWER_MESH_SECRET`` (falls back to ``WATCHTOWER_API_TOKEN``) so
a node can't be spoofed even on a shared LAN. Datagrams failing the HMAC check
are dropped silently.

The wire protocol + state machine (``MeshState``) are pure and socket-free so
they can be unit-tested deterministically; ``MeshDaemon`` is the thin asyncio
UDP driver on top.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import random
import socket
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ── Tunables (SWIM's own suggested small constants; all env-overridable) ──────

def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, ""))
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, ""))
    except (TypeError, ValueError):
        return default


PROTOCOL_PERIOD = _env_float("WATCHTOWER_MESH_PERIOD_SECS", 1.0)   # T
INDIRECT_PROBES = _env_int("WATCHTOWER_MESH_K", 3)                 # k
PING_TIMEOUT = _env_float("WATCHTOWER_MESH_PING_TIMEOUT_SECS", 0.5)
# Lifeguard: suspects get SUSPICION_MULT protocol periods to refute before DEAD.
SUSPICION_MULT = _env_int("WATCHTOWER_MESH_SUSPICION_MULT", 5)
DEFAULT_PORT = _env_int("WATCHTOWER_MESH_PORT", 7946)  # memberlist's default
# Membership deltas are gossiped this many times before we stop re-sending them
# (each still rides every datagram until the counter runs out).
GOSSIP_FANOUT = _env_int("WATCHTOWER_MESH_GOSSIP_REPEATS", 6)


class MemberState(str, Enum):
    ALIVE = "alive"
    SUSPECT = "suspect"
    DEAD = "dead"


class MsgType(str, Enum):
    PING = "ping"
    ACK = "ack"
    PING_REQ = "ping-req"          # "please indirect-ping <target> for me"
    PING_REQ_ACK = "ping-req-ack"  # relayed ack back to the original prober


@dataclass
class Member:
    """One node in the mesh, identified by its ``addr`` (tailscale-ip:port)."""
    addr: str
    state: MemberState = MemberState.ALIVE
    incarnation: int = 0
    # Wall-clock (monotonic) when the current state was entered — drives the
    # suspicion timeout. Not gossiped; purely local bookkeeping.
    state_since: float = field(default_factory=time.monotonic)
    name: str = ""
    # Latest control-plane state version this peer advertised (for gossip-
    # triggered state sync). 0 = not seen / not a primary.
    state_version: int = 0


@dataclass
class _GossipItem:
    """A membership delta queued for piggybacking, with a send budget."""
    addr: str
    state: MemberState
    incarnation: int
    name: str
    remaining: int


# ── HMAC-authenticated framing (pure) ────────────────────────────────────────

def _mesh_secret() -> bytes:
    secret = os.getenv("WATCHTOWER_MESH_SECRET") or os.getenv("WATCHTOWER_API_TOKEN") or ""
    return secret.encode("utf-8")


def encode_datagram(payload: dict, *, secret: Optional[bytes] = None) -> bytes:
    """Serialise ``payload`` to JSON and prepend a hex HMAC-SHA256 tag.

    Wire format: ``<64-hex-char tag>.<json bytes>``. The tag covers the JSON
    body so a receiver can reject anything not signed with the shared secret.
    """
    key = secret if secret is not None else _mesh_secret()
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    tag = hmac.new(key, body, hashlib.sha256).hexdigest().encode("ascii")
    return tag + b"." + body


def decode_datagram(raw: bytes, *, secret: Optional[bytes] = None) -> Optional[dict]:
    """Verify the HMAC and return the payload, or ``None`` if auth/format fails.

    Constant-time tag comparison; never raises on malformed input.
    """
    key = secret if secret is not None else _mesh_secret()
    try:
        tag, body = raw.split(b".", 1)
    except ValueError:
        return None
    expected = hmac.new(key, body, hashlib.sha256).hexdigest().encode("ascii")
    if not hmac.compare_digest(tag, expected):
        return None
    try:
        obj = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return obj if isinstance(obj, dict) else None


# ── The state machine (pure, socket-free — the unit-testable core) ────────────

class MeshState:
    """Local view of cluster membership + the SWIM merge rules.

    Deterministic and side-effect-free apart from its own dict. The daemon
    feeds it incoming gossip and asks it what to probe / what changed; tests
    drive it directly with no network.
    """

    def __init__(self, self_addr: str, self_name: str = "") -> None:
        self.self_addr = self_addr
        self.self_name = self_name
        self.incarnation = 0  # ours; bumped to refute a wrong SUSPECT about us
        self.members: Dict[str, Member] = {}
        self._gossip: List[_GossipItem] = []

    # -- membership bookkeeping ------------------------------------------------

    def add_peer(self, addr: str, name: str = "") -> None:
        """Seed a peer (e.g. from tailscale discovery). No-op if already known
        or if it's us."""
        if addr == self.self_addr or addr in self.members:
            if addr in self.members and name and not self.members[addr].name:
                self.members[addr].name = name
            return
        self.members[addr] = Member(addr=addr, name=name)
        self._queue_gossip(addr, MemberState.ALIVE, 0, name)

    def alive_peers(self) -> List[Member]:
        return [m for m in self.members.values() if m.state == MemberState.ALIVE]

    def snapshot(self) -> List[dict]:
        """Serialisable view for the status endpoint."""
        out = [{
            "addr": self.self_addr,
            "name": self.self_name,
            "state": MemberState.ALIVE.value,
            "incarnation": self.incarnation,
            "self": True,
        }]
        for m in self.members.values():
            out.append({
                "addr": m.addr,
                "name": m.name,
                "state": m.state.value,
                "incarnation": m.incarnation,
                "self": False,
            })
        return out

    # -- SWIM merge rules ------------------------------------------------------

    def _queue_gossip(self, addr: str, state: MemberState, incarnation: int, name: str) -> None:
        # Replace any queued item for the same addr — only the latest matters.
        self._gossip = [g for g in self._gossip if g.addr != addr]
        self._gossip.append(_GossipItem(addr, state, incarnation, name, GOSSIP_FANOUT))

    def apply_update(self, addr: str, state: str, incarnation: int, name: str = "") -> bool:
        """Merge one gossiped membership fact. Returns True if our view changed.

        The core SWIM ordering rules:
          * A rumor about *us* that says SUSPECT/DEAD is refuted by bumping our
            own incarnation above the rumor's and re-broadcasting ALIVE.
          * For a peer, a higher incarnation always wins. At equal incarnation,
            SUSPECT overrides ALIVE and DEAD overrides everything (monotone
            toward "more dead").
        """
        try:
            new_state = MemberState(state)
        except ValueError:
            return False

        # Rumor about ourselves → refute if it's not "we're alive".
        if addr == self.self_addr:
            if new_state in (MemberState.SUSPECT, MemberState.DEAD) and incarnation >= self.incarnation:
                self.incarnation = incarnation + 1
                self._queue_gossip(self.self_addr, MemberState.ALIVE, self.incarnation, self.self_name)
                logger.info("mesh: refuted %s about self, incarnation now %d", state, self.incarnation)
                return True
            return False

        m = self.members.get(addr)
        if m is None:
            # Learn about a brand-new peer, unless the news is that it's dead.
            if new_state == MemberState.DEAD:
                return False
            m = Member(addr=addr, state=new_state, incarnation=incarnation, name=name)
            self.members[addr] = m
            self._queue_gossip(addr, new_state, incarnation, name)
            return True

        if name and not m.name:
            m.name = name

        # Strictly newer incarnation wins outright.
        if incarnation > m.incarnation:
            return self._transition(m, new_state, incarnation)
        # Same incarnation: allow only "more dead" transitions.
        if incarnation == m.incarnation:
            if _severity(new_state) > _severity(m.state):
                return self._transition(m, new_state, incarnation)
        return False

    def _transition(self, m: Member, new_state: MemberState, incarnation: int) -> bool:
        if m.state == new_state and m.incarnation == incarnation:
            return False
        m.state = new_state
        m.incarnation = incarnation
        m.state_since = time.monotonic()
        self._queue_gossip(m.addr, new_state, incarnation, m.name)
        logger.debug("mesh: %s -> %s (inc=%d)", m.addr, new_state.value, incarnation)
        return True

    def mark_suspect(self, addr: str) -> bool:
        """Local failure-detector verdict: no direct or indirect ack. Moves an
        ALIVE member to SUSPECT at its current incarnation."""
        m = self.members.get(addr)
        if m is None or m.state != MemberState.ALIVE:
            return False
        return self._transition(m, MemberState.SUSPECT, m.incarnation)

    def mark_alive_from_ack(self, addr: str) -> bool:
        """A member answered a (direct or indirect) probe — clear SUSPECT."""
        m = self.members.get(addr)
        if m is None:
            return False
        if m.state == MemberState.SUSPECT:
            return self._transition(m, MemberState.ALIVE, m.incarnation)
        m.state_since = m.state_since  # ALIVE stays ALIVE
        return False

    def expire_suspects(self, now: Optional[float] = None) -> List[str]:
        """Promote SUSPECT → DEAD once the suspicion window elapses. Returns the
        addrs newly declared dead (the failover trigger consumes these)."""
        now = time.monotonic() if now is None else now
        window = SUSPICION_MULT * PROTOCOL_PERIOD
        dead: List[str] = []
        for m in list(self.members.values()):
            if m.state == MemberState.SUSPECT and (now - m.state_since) >= window:
                self._transition(m, MemberState.DEAD, m.incarnation)
                dead.append(m.addr)
        return dead

    # -- gossip piggybacking ---------------------------------------------------

    def drain_gossip(self, limit: int = 8) -> List[dict]:
        """Return up to ``limit`` membership deltas to piggyback, decrementing
        each item's send budget and dropping the spent ones."""
        out: List[dict] = []
        keep: List[_GossipItem] = []
        for g in self._gossip:
            if len(out) < limit:
                out.append({
                    "addr": g.addr, "state": g.state.value,
                    "incarnation": g.incarnation, "name": g.name,
                })
                g.remaining -= 1
            if g.remaining > 0:
                keep.append(g)
        self._gossip = keep
        return out

    def ingest_gossip(self, items: List[dict]) -> bool:
        changed = False
        for it in items or []:
            if not isinstance(it, dict):
                continue
            changed |= self.apply_update(
                str(it.get("addr", "")),
                str(it.get("state", "")),
                int(it.get("incarnation", 0) or 0),
                str(it.get("name", "")),
            )
        return changed

    def random_probe_target(self, rng: Optional[random.Random] = None) -> Optional[str]:
        """Pick a peer to direct-ping this period. SWIM uses round-robin+shuffle;
        uniform-random is simpler and preserves the coverage guarantee."""
        candidates = [m.addr for m in self.members.values() if m.state != MemberState.DEAD]
        if not candidates:
            return None
        return (rng or random).choice(candidates)

    def random_relays(self, exclude: str, k: int, rng: Optional[random.Random] = None) -> List[str]:
        pool = [m.addr for m in self.members.values()
                if m.addr != exclude and m.state == MemberState.ALIVE]
        (rng or random).shuffle(pool)
        return pool[:k]


def _severity(state: MemberState) -> int:
    return {MemberState.ALIVE: 0, MemberState.SUSPECT: 1, MemberState.DEAD: 2}[state]


# ── Async UDP driver ─────────────────────────────────────────────────────────

class MeshDaemon:
    """Runs the SWIM protocol over a UDP socket. Thin — all decisions live in
    ``MeshState``. Best-effort throughout: a mesh failure must never take down
    the API, so every network op is guarded and logged, not raised."""

    def __init__(self, self_addr: str, self_name: str = "", port: int = DEFAULT_PORT) -> None:
        self.port = port
        self.state = MeshState(self_addr=self_addr, self_name=self_name)
        self._transport: Optional[asyncio.DatagramTransport] = None
        self._task: Optional[asyncio.Task] = None
        self._pending_acks: Dict[str, asyncio.Future] = {}
        self._on_dead = None  # optional callback(addr) invoked when a peer dies
        # State-sync hooks: a provider for OUR advertised version, and a
        # callback fired when a PEER's advertised version advances.
        self._version_fn = None       # () -> int
        self._on_version = None       # (peer_addr, version) -> None
        self._running = False

    def on_dead(self, callback) -> None:
        self._on_dead = callback

    def set_version_provider(self, fn) -> None:
        """``fn() -> int`` returning this node's control-plane state version,
        stamped onto every outgoing datagram so standbys know when to pull."""
        self._version_fn = fn

    def on_version(self, callback) -> None:
        """``callback(peer_addr, version)`` fired whenever a peer advertises a
        higher state version than we last saw from it."""
        self._on_version = callback

    def _my_version(self) -> int:
        if self._version_fn is None:
            return 0
        try:
            return int(self._version_fn())
        except Exception:  # noqa: BLE001
            return 0

    def seed_from_tailscale(self) -> int:
        """Add all online tailnet peers to the membership list. Returns count."""
        try:
            from watchtower import tailscale
            n = 0
            for p in tailscale.online_peers():
                addr = f"{p.tailscale_ip}:{self.port}"
                if addr != self.state.self_addr:
                    self.state.add_peer(addr, name=p.hostname)
                    n += 1
            return n
        except Exception:  # noqa: BLE001 - discovery is best-effort
            logger.debug("mesh: tailscale seed failed", exc_info=True)
            return 0

    # -- lifecycle -------------------------------------------------------------

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        self._transport, _ = await loop.create_datagram_endpoint(
            lambda: _MeshProtocol(self),
            local_addr=("0.0.0.0", self.port),
        )
        self.seed_from_tailscale()
        self._running = True
        self._task = loop.create_task(self._run())
        logger.info("mesh: started on udp/%d as %s (%d seed peers)",
                    self.port, self.state.self_addr, len(self.state.members))

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        if self._transport:
            self._transport.close()

    # -- the protocol loop -----------------------------------------------------

    async def _run(self) -> None:
        # Re-seed occasionally so newly-joined tailnet nodes get picked up.
        reseed_every = 30
        period_count = 0
        while self._running:
            try:
                await self._protocol_period()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - a tick must never kill the loop
                logger.exception("mesh: protocol period errored")
            period_count += 1
            if period_count % reseed_every == 0:
                self.seed_from_tailscale()

    async def _protocol_period(self) -> None:
        # 1) expire suspects → dead, fire the failover callback for each.
        for addr in self.state.expire_suspects():
            logger.info("mesh: %s declared DEAD", addr)
            if self._on_dead:
                try:
                    self._on_dead(addr)
                except Exception:  # noqa: BLE001
                    logger.exception("mesh: on_dead callback errored for %s", addr)

        # 2) pick a target and direct-ping it.
        target = self.state.random_probe_target()
        if target is None:
            await asyncio.sleep(PROTOCOL_PERIOD)
            return

        acked = await self._ping(target)
        if acked:
            self.state.mark_alive_from_ack(target)
        else:
            # 3) direct ping silent → ask k relays to indirect-ping it.
            relays = self.state.random_relays(exclude=target, k=INDIRECT_PROBES)
            indirect_ok = await self._ping_req(target, relays)
            if indirect_ok:
                self.state.mark_alive_from_ack(target)
            else:
                self.state.mark_suspect(target)

        # 4) sleep out the rest of the period.
        await asyncio.sleep(PROTOCOL_PERIOD)

    # -- wire ops --------------------------------------------------------------

    def _send(self, addr: str, msg_type: MsgType, extra: Optional[dict] = None) -> None:
        if not self._transport:
            return
        payload = {
            "type": msg_type.value,
            "from": self.state.self_addr,
            "name": self.state.self_name,
            "gossip": self.state.drain_gossip(),
            "sv": self._my_version(),   # our control-plane state version
        }
        if extra:
            payload.update(extra)
        try:
            host, port = addr.rsplit(":", 1)
            self._transport.sendto(encode_datagram(payload), (host, int(port)))
        except Exception:  # noqa: BLE001 - unreachable host, bad addr, etc.
            logger.debug("mesh: send to %s failed", addr, exc_info=True)

    async def _ping(self, addr: str) -> bool:
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending_acks[addr] = fut
        self._send(addr, MsgType.PING)
        try:
            await asyncio.wait_for(fut, timeout=PING_TIMEOUT)
            return True
        except asyncio.TimeoutError:
            return False
        finally:
            self._pending_acks.pop(addr, None)

    async def _ping_req(self, target: str, relays: List[str]) -> bool:
        if not relays:
            return False
        key = f"req:{target}"
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending_acks[key] = fut
        for relay in relays:
            self._send(relay, MsgType.PING_REQ, {"target": target})
        try:
            await asyncio.wait_for(fut, timeout=PING_TIMEOUT * 2)
            return True
        except asyncio.TimeoutError:
            return False
        finally:
            self._pending_acks.pop(key, None)

    def handle_datagram(self, payload: dict, sender: Tuple[str, int]) -> None:
        """Dispatch a verified incoming datagram. Called by the protocol."""
        self.state.ingest_gossip(payload.get("gossip", []))
        mtype = payload.get("type")
        frm = payload.get("from", "")
        name = payload.get("name", "")
        if frm and frm not in self.state.members and frm != self.state.self_addr:
            self.state.add_peer(frm, name=name)
        # Any contact from a peer is proof of life.
        if frm:
            self.state.mark_alive_from_ack(frm)
            self._observe_version(frm, int(payload.get("sv", 0) or 0))

        if mtype == MsgType.PING.value:
            self._send(frm, MsgType.ACK)
        elif mtype == MsgType.ACK.value:
            fut = self._pending_acks.get(frm)
            if fut and not fut.done():
                fut.set_result(True)
        elif mtype == MsgType.PING_REQ.value:
            # Relay: indirect-ping the target on the requester's behalf.
            target = payload.get("target", "")
            if target:
                asyncio.get_running_loop().create_task(
                    self._relay_ping(target, frm)
                )
        elif mtype == MsgType.PING_REQ_ACK.value:
            target = payload.get("target", "")
            fut = self._pending_acks.get(f"req:{target}")
            if fut and not fut.done():
                fut.set_result(True)

    def _observe_version(self, addr: str, version: int) -> None:
        """Record a peer's advertised state version; fire on_version when it
        advances. This is the gossip-triggered-sync signal — a standby's
        callback pulls the primary's new state immediately."""
        if version <= 0:
            return
        m = self.state.members.get(addr)
        if m is None:
            return
        if version > m.state_version:
            m.state_version = version
            if self._on_version:
                try:
                    self._on_version(addr, version)
                except Exception:  # noqa: BLE001
                    logger.debug("mesh: on_version callback errored", exc_info=True)

    async def _relay_ping(self, target: str, requester: str) -> None:
        if await self._ping(target):
            self._send(requester, MsgType.PING_REQ_ACK, {"target": target})


class _MeshProtocol(asyncio.DatagramProtocol):
    def __init__(self, daemon: MeshDaemon) -> None:
        self.daemon = daemon

    def datagram_received(self, data: bytes, addr: Tuple[str, int]) -> None:
        payload = decode_datagram(data)
        if payload is None:
            return  # bad HMAC or malformed — drop silently
        try:
            self.daemon.handle_datagram(payload, addr)
        except Exception:  # noqa: BLE001
            logger.debug("mesh: handle_datagram errored", exc_info=True)


# ── Module-level singleton + start/stop (mirrors control_plane_sync) ──────────

_daemon: Optional[MeshDaemon] = None


def get_daemon() -> Optional[MeshDaemon]:
    return _daemon


def self_addr(port: int = DEFAULT_PORT) -> Optional[str]:
    """This node's mesh address (tailscale-ip:port), or None if no tailnet."""
    try:
        from watchtower import tailscale
        ip = tailscale.local_ip()
        return f"{ip}:{port}" if ip else None
    except Exception:  # noqa: BLE001
        return None


def self_name() -> str:
    try:
        return socket.gethostname()
    except Exception:  # noqa: BLE001
        return "watchtower-node"


async def start() -> Optional[MeshDaemon]:
    """Start the mesh daemon. No-op (returns None) when disabled or when this
    node isn't on a tailnet (nothing to mesh with)."""
    global _daemon
    if _daemon is not None:
        return _daemon
    if os.getenv("WATCHTOWER_MESH_DISABLE", "").lower() == "true":
        logger.info("mesh: disabled via WATCHTOWER_MESH_DISABLE")
        return None
    addr = self_addr()
    if not addr:
        logger.info("mesh: no tailscale IP — mesh not started (standalone node)")
        return None
    daemon = MeshDaemon(self_addr=addr, self_name=self_name())
    # Wire the failover trigger before starting so no dead-event is missed.
    try:
        from watchtower import failover
        daemon.on_dead(failover.on_peer_dead)
    except Exception:  # noqa: BLE001 - failover is optional
        logger.debug("mesh: failover hook unavailable", exc_info=True)
    # Wire gossip state-sync: advertise our version, pull when the primary's
    # advances. Both sides best-effort — a missing hook just falls back to the
    # timed pull.
    try:
        from watchtower import control_plane_sync
        daemon.set_version_provider(lambda: control_plane_sync.current_state_version())
        daemon.on_version(control_plane_sync.on_primary_version)
    except Exception:  # noqa: BLE001 - state-sync is optional
        logger.debug("mesh: state-sync hooks unavailable", exc_info=True)
    await daemon.start()
    _daemon = daemon
    return daemon


async def stop() -> None:
    global _daemon
    if _daemon is not None:
        await _daemon.stop()
        _daemon = None


def status() -> dict:
    """Live mesh view for the status endpoint. Safe to call when not running."""
    if _daemon is None:
        return {"running": False, "self_addr": self_addr(), "members": []}
    return {
        "running": True,
        "self_addr": _daemon.state.self_addr,
        "self_name": _daemon.state.self_name,
        "members": _daemon.state.snapshot(),
    }
