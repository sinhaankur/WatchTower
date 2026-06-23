"""Unit tests for the shared CLI tool resolver.

watchtower.tool_resolver is the single source of truth for locating
system binaries (tailscale, podman, docker, cloudflared). It exists to
kill the "installed here, missing there" drift that came from two
divergent copies of this logic — so these tests pin the contract every
caller now depends on:

  - PATH wins when present
  - GUI-bundle / package-manager fallback paths are probed when PATH misses
    (the macOS Tailscale.app case is the canonical one)
  - unknown commands and genuinely-missing tools return None
"""
from __future__ import annotations

from watchtower import tool_resolver


def test_path_hit_wins(monkeypatch):
    monkeypatch.setattr(tool_resolver.shutil, "which", lambda _n: "/usr/bin/podman")
    assert tool_resolver.resolve_tool("podman") == "/usr/bin/podman"


def test_falls_back_to_gui_bundle_when_not_on_path(monkeypatch):
    """The macOS Tailscale GUI bundles the CLI but doesn't symlink it onto
    PATH — the resolver must still find it via the fallback table."""
    gui = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    monkeypatch.setattr(tool_resolver.shutil, "which", lambda _n: None)
    monkeypatch.setattr(tool_resolver.os.path, "isfile", lambda p: p == gui)
    monkeypatch.setattr(tool_resolver.os, "access", lambda p, _m: p == gui)
    assert tool_resolver.resolve_tool("tailscale") == gui


def test_returns_none_when_nothing_found(monkeypatch):
    monkeypatch.setattr(tool_resolver.shutil, "which", lambda _n: None)
    monkeypatch.setattr(tool_resolver.os.path, "isfile", lambda _p: False)
    assert tool_resolver.resolve_tool("tailscale") is None


def test_unknown_tool_has_no_fallback(monkeypatch):
    """A command with no fallback table entry just returns whatever PATH
    says — and None when PATH misses, never an error."""
    monkeypatch.setattr(tool_resolver.shutil, "which", lambda _n: None)
    # isfile must never be consulted for an unknown tool (empty fallback).
    monkeypatch.setattr(
        tool_resolver.os.path, "isfile",
        lambda _p: (_ for _ in ()).throw(AssertionError("should not probe fallback")),
    )
    assert tool_resolver.resolve_tool("totally-made-up-binary") is None


def test_tailscale_binary_convenience_delegates(monkeypatch):
    monkeypatch.setattr(
        tool_resolver, "resolve_tool",
        lambda cmd: "/usr/local/bin/tailscale" if cmd == "tailscale" else None,
    )
    assert tool_resolver.tailscale_binary() == "/usr/local/bin/tailscale"


def test_fallback_table_includes_macos_tailscale_gui():
    """Guard the specific path that was missing before the unification —
    if someone trims the table, this fails loudly."""
    paths = tool_resolver._FALLBACK_TOOL_PATHS["tailscale"]
    assert "/Applications/Tailscale.app/Contents/MacOS/Tailscale" in paths
