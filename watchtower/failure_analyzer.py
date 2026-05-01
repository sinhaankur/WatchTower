"""Pattern-based classifier for deployment failures.

The autonomous-ops loop's first half is "detect & diagnose"; this module
is the diagnose half. Given the build/deploy log of a failed deployment,
:func:`classify_failure` walks a small library of regexes (most-specific
first) and returns a structured ``FailureDiagnosis`` describing the kind
of failure, a human cause, and a suggested fix.

When no pattern matches, the result is ``FailureKind.UNKNOWN`` and
callers fall through to the LLM agent for free-form analysis. That
keeps the surface deterministic for the common cases (no API cost, no
latency, easy to test) while still giving the agent a hook for novel
failures.

Each pattern lives in :data:`PATTERNS` as a ``(kind, compiled_regex,
fix_factory)`` tuple. Adding a new pattern is one entry plus one test
in ``tests/test_failure_analyzer.py``.

This is intentionally regex-only and synchronous — pattern matching on
~10 KB of log text is microsecond-cheap, well under the budget of a
single GET request.
"""

from __future__ import annotations

import enum
import re
from dataclasses import dataclass, field, asdict
from typing import Callable, Optional


class FailureKind(str, enum.Enum):
    PORT_IN_USE = "port_in_use"
    MISSING_ENV_VAR = "missing_env_var"
    PACKAGE_NOT_FOUND = "package_not_found"
    BUILD_OOM = "build_oom"
    PERMISSION_DENIED = "permission_denied"
    DISK_FULL = "disk_full"
    UNKNOWN = "unknown"


@dataclass
class FailureFix:
    """User-facing description of how to fix a classified failure."""

    description: str
    command: Optional[str] = None
    auto_applicable: bool = False


@dataclass
class FailureDiagnosis:
    """Result of classifying a failed deployment's log."""

    kind: FailureKind
    cause: str
    fix: FailureFix
    matched_text: Optional[str] = None
    extracted: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["kind"] = self.kind.value
        return d


# ── Pattern factories ────────────────────────────────────────────────────────
#
# Each takes a regex Match and returns a FailureDiagnosis. Factories are
# the place to extract context from the log (the env var name, the
# missing module, the offending port) and embed it in the cause string
# so the UI can render specifics rather than generic "missing env var".

def _fix_port_in_use(match: re.Match) -> FailureDiagnosis:
    port = match.group("port") if "port" in match.groupdict() else None
    cause = (
        f"Port {port} is already in use on the deploy target."
        if port
        else "Port already in use on the deploy target."
    )
    fix = FailureFix(
        description=(
            "WatchTower can pick a free port automatically — click Apply "
            "fix to retry the deployment with a recommended free port."
        ),
        # The recommend-port endpoint is the same one the SetupWizard uses.
        # Marking auto_applicable=True is safe here: changing a port doesn't
        # need a human decision (unlike installing a package or setting an
        # env var value).
        auto_applicable=True,
    )
    return FailureDiagnosis(
        kind=FailureKind.PORT_IN_USE,
        cause=cause,
        fix=fix,
        matched_text=match.group(0),
        extracted={"port": port} if port else {},
    )


def _fix_missing_env_var(match: re.Match) -> FailureDiagnosis:
    var = match.group("var") if "var" in match.groupdict() else None
    cause = (
        f"The application failed to start because the environment "
        f"variable '{var}' is not set."
        if var
        else "The application failed to start because a required environment variable is not set."
    )
    fix = FailureFix(
        description=(
            f"Add '{var}' under Environment Variables for this project, "
            f"then redeploy. (We can't auto-apply because we don't know "
            f"the correct value — that's project-specific.)"
            if var
            else "Check the build log for the missing variable name, add it under Environment Variables, then redeploy."
        ),
        auto_applicable=False,
    )
    return FailureDiagnosis(
        kind=FailureKind.MISSING_ENV_VAR,
        cause=cause,
        fix=fix,
        matched_text=match.group(0),
        extracted={"var": var} if var else {},
    )


def _fix_package_not_found(match: re.Match) -> FailureDiagnosis:
    pkg = match.group("pkg") if "pkg" in match.groupdict() else None
    cause = (
        f"The build couldn't find the package '{pkg}'."
        if pkg
        else "The build couldn't find a required package."
    )
    fix = FailureFix(
        description=(
            f"Add '{pkg}' to your package.json / requirements.txt / pyproject.toml "
            f"(whichever applies for this project's stack), commit, and redeploy."
            if pkg
            else "Check the missing package name in the build log, add it to your project's dependency manifest, commit, and redeploy."
        ),
        auto_applicable=False,
    )
    return FailureDiagnosis(
        kind=FailureKind.PACKAGE_NOT_FOUND,
        cause=cause,
        fix=fix,
        matched_text=match.group(0),
        extracted={"package": pkg} if pkg else {},
    )


def _fix_build_oom(match: re.Match) -> FailureDiagnosis:
    return FailureDiagnosis(
        kind=FailureKind.BUILD_OOM,
        cause="The build was killed by the OS because it ran out of memory (exit code 137 / SIGKILL).",
        fix=FailureFix(
            description=(
                "Reduce build parallelism or scale up the deploy node. "
                "For Node projects: set NODE_OPTIONS='--max-old-space-size=2048' "
                "in env vars. For Rust/Go: set CARGO_BUILD_JOBS=1 / GOMAXPROCS=1. "
                "Otherwise add memory to the target node."
            ),
            auto_applicable=False,
        ),
        matched_text=match.group(0),
    )


def _fix_permission_denied(match: re.Match) -> FailureDiagnosis:
    target = match.group("target") if "target" in match.groupdict() else None
    cause = (
        f"Permission denied accessing '{target}' on the deploy target."
        if target
        else "Permission denied during build or deploy."
    )
    fix = FailureFix(
        description=(
            "Check that the deploy user owns the target directory, the "
            "Podman socket is reachable, or the binary you're running is "
            "executable. For socket issues: `loginctl enable-linger <user>` "
            "and confirm `XDG_RUNTIME_DIR` is set on the node."
        ),
        auto_applicable=False,
    )
    return FailureDiagnosis(
        kind=FailureKind.PERMISSION_DENIED,
        cause=cause,
        fix=fix,
        matched_text=match.group(0),
        extracted={"target": target} if target else {},
    )


def _fix_disk_full(match: re.Match) -> FailureDiagnosis:
    return FailureDiagnosis(
        kind=FailureKind.DISK_FULL,
        cause="The deploy target has run out of disk space.",
        fix=FailureFix(
            description=(
                "Run `df -h` on the deploy node, then clean up. Common "
                "wins: `podman image prune -af` (stale build images) and "
                "`journalctl --vacuum-size=200M` (system logs). Once you've "
                "freed space, redeploy."
            ),
            auto_applicable=False,
        ),
        matched_text=match.group(0),
    )


# ── Pattern library ──────────────────────────────────────────────────────────
#
# Order matters: more specific first. The first regex to match wins, so
# disk-full's "no space left on device" must beat the more generic
# permission_denied's "denied" if both happen to appear.
#
# Multiline matches use re.IGNORECASE so we don't have to spell every
# capitalization variant. ``\bnamed\b`` etc keep word-boundary discipline.

PATTERNS: list[tuple[FailureKind, re.Pattern, Callable[[re.Match], FailureDiagnosis]]] = [
    (
        FailureKind.DISK_FULL,
        re.compile(r"no space left on device|ENOSPC", re.IGNORECASE),
        _fix_disk_full,
    ),
    (
        FailureKind.BUILD_OOM,
        re.compile(
            r"killed.{0,40}out of memory"
            r"|exit code (?:137|128\+9)"
            r"|signal: killed"
            r"|out of memory.*(?:killed|killing)",
            re.IGNORECASE,
        ),
        _fix_build_oom,
    ),
    (
        FailureKind.PORT_IN_USE,
        re.compile(
            r"address already in use(?:.*?:(?P<port>\d+))?"
            r"|EADDRINUSE(?:.*?(?P<port2>\d+))?"
            r"|bind:.*?(?P<port3>\d+).*?already in use",
            re.IGNORECASE,
        ),
        # Wrap so the optional named groups all coalesce into "port".
        lambda m: _fix_port_in_use(_normalize_port_match(m)),
    ),
    (
        FailureKind.MISSING_ENV_VAR,
        # Three flavours: Python KeyError on os.environ, Node missing
        # process.env access, and bash 'unbound variable' under set -u.
        re.compile(
            r"KeyError:\s*['\"](?P<var>[A-Z][A-Z0-9_]+)['\"]"
            r"|process\.env\.(?P<var2>[A-Z][A-Z0-9_]+)\s+is\s+(?:undefined|not\s+set)"
            r"|(?P<var3>[A-Z][A-Z0-9_]{2,}):\s+unbound variable",
            re.IGNORECASE,
        ),
        lambda m: _fix_missing_env_var(_normalize_var_match(m)),
    ),
    (
        FailureKind.PACKAGE_NOT_FOUND,
        re.compile(
            r"ModuleNotFoundError:\s*No module named\s*['\"](?P<pkg>[\w.\-]+)['\"]"
            r"|Cannot find module\s*['\"](?P<pkg2>[\w./\-@]+)['\"]"
            r"|error\[E0463\]:\s*can't find crate for `(?P<pkg3>[\w\-]+)`"
            r"|go:.*?cannot find module providing package (?P<pkg4>[\w./\-]+)",
            re.IGNORECASE,
        ),
        lambda m: _fix_package_not_found(_normalize_pkg_match(m)),
    ),
    (
        FailureKind.PERMISSION_DENIED,
        re.compile(
            r"permission denied(?:[:\s]+(?P<target>[/\w.\-]+))?"
            r"|EACCES(?:[:\s]+(?P<target2>[/\w.\-]+))?",
            re.IGNORECASE,
        ),
        lambda m: _fix_permission_denied(_normalize_target_match(m)),
    ),
]


def _normalize_port_match(m: re.Match) -> re.Match:
    # Collapse alternative named groups (port/port2/port3) into a single
    # 'port' so the factory has one place to look.
    g = m.groupdict()
    chosen = g.get("port") or g.get("port2") or g.get("port3")
    if chosen and not g.get("port"):
        # Patch the dict via _RewrittenMatch so the factory's group("port") works.
        return _RewrittenMatch(m, {"port": chosen})
    return m


def _normalize_var_match(m: re.Match) -> re.Match:
    g = m.groupdict()
    chosen = g.get("var") or g.get("var2") or g.get("var3")
    if chosen and not g.get("var"):
        return _RewrittenMatch(m, {"var": chosen})
    return m


def _normalize_pkg_match(m: re.Match) -> re.Match:
    g = m.groupdict()
    chosen = g.get("pkg") or g.get("pkg2") or g.get("pkg3") or g.get("pkg4")
    if chosen and not g.get("pkg"):
        return _RewrittenMatch(m, {"pkg": chosen})
    return m


def _normalize_target_match(m: re.Match) -> re.Match:
    g = m.groupdict()
    chosen = g.get("target") or g.get("target2")
    if chosen and not g.get("target"):
        return _RewrittenMatch(m, {"target": chosen})
    return m


class _RewrittenMatch:
    """Tiny match-like wrapper that overlays additional groupdict keys.

    re.Match objects are immutable, so when we want to coalesce
    alternative named groups (port / port2 / port3) into a single
    canonical name without rewriting every regex, we wrap the original
    match and intercept :meth:`group` / :meth:`groupdict` lookups.
    """

    def __init__(self, original: re.Match, overlay: dict) -> None:
        self._original = original
        self._overlay = overlay

    def group(self, *args):  # type: ignore[override]
        if len(args) == 1 and args[0] in self._overlay:
            return self._overlay[args[0]]
        return self._original.group(*args)

    def groupdict(self, default=None):  # type: ignore[override]
        d = dict(self._original.groupdict(default=default))
        d.update(self._overlay)
        return d


def classify_failure(log_excerpt: str) -> FailureDiagnosis:
    """Classify a failed deployment's log excerpt.

    Returns the first matching diagnosis from :data:`PATTERNS`, or a
    fallthrough ``FailureKind.UNKNOWN`` if nothing matched. Callers can
    use that signal to escalate to the LLM agent.

    The excerpt is searched with ``re.search`` (not ``match``) so the
    pattern can fire anywhere in the text. Callers should pass the
    last few hundred lines — that's where the actionable error usually
    is, and limiting input keeps regex cost bounded.
    """

    if not log_excerpt:
        return FailureDiagnosis(
            kind=FailureKind.UNKNOWN,
            cause="No build/deploy log was captured for this deployment.",
            fix=FailureFix(
                description=(
                    "Re-run the deployment to capture a fresh log. If the "
                    "log is still empty after retry, the build process "
                    "may be exiting before producing output — check that "
                    "the build command path is correct."
                ),
                auto_applicable=False,
            ),
        )

    for kind, pattern, factory in PATTERNS:
        m = pattern.search(log_excerpt)
        if m is not None:
            return factory(m)

    return FailureDiagnosis(
        kind=FailureKind.UNKNOWN,
        cause="The failure didn't match any known pattern.",
        fix=FailureFix(
            description=(
                "Open the deployment's full log to investigate, or use "
                "the WatchTower agent to analyze it — the agent can "
                "interpret stack traces that don't match a fixed pattern."
            ),
            auto_applicable=False,
        ),
    )
