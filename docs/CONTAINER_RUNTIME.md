# Container Runtime — Podman or Docker

**Status:** runtime-agnostic as of 2026-09-29

WatchTower runs on **either Podman or Docker**. It auto-detects what you have
installed and uses it — no reason to make someone install a second runtime
when the one they already run works fine.

## Default behaviour

- **Podman-first, Docker fallback.** WatchTower prefers Podman because
  rootless/daemonless is the safest default for "turn your own PC into a
  server" — a container escape doesn't own root. If Podman isn't installed
  but Docker is, WatchTower uses Docker automatically.
- **Auto-detection** happens through one shared seam
  (`watchtower.managed_db_runtime._podman_path` /
  `detect_runtime()`), so every local-runtime feature (Run Locally, the
  Containers page, deploys) picks up the same runtime consistently.

## Choosing a runtime explicitly

Set `WATCHTOWER_CONTAINER_RUNTIME`:

| Value | Behaviour |
|-------|-----------|
| _(unset)_ | Podman first, then Docker (default) |
| `docker` | Docker first, then Podman |
| `podman` | Podman **only** — never silently fall back to Docker |

The active runtime is reported by `GET /api/podman/status` (the `runtime`
field: `"podman"` or `"docker"`) and on the system-diagnostics page, so you
can always see what WatchTower resolved.

## What works on each

| Feature | Podman | Docker |
|---------|:------:|:------:|
| Deploy from GitHub | ✅ | ✅ |
| Run Locally (preview a project) | ✅ | ✅ |
| Containers page (create/start/stop/logs) | ✅ | ✅ |
| Rootless by default | ✅ | ❌ (root daemon) |
| **Managed databases** | ✅ | ⚠️ needs Podman |

### The one caveat: managed databases

Managed databases run their engine inside a **Podman pod** (the addressable
unit WatchTower uses for replication + backup). Docker has no `pod`
primitive, so on a **Docker-only host**, creating a managed database fails
fast with a clear message:

> Managed databases currently require Podman (they run inside a Podman pod,
> which Docker doesn't have). Install Podman to use managed databases —
> everything else in WatchTower works with Docker.

**Tracked follow-up:** a Docker fallback that maps the pod to a plain
container on a dedicated Docker network (equivalent isolation, no pod
primitive). Until then, a Docker-only host gets the honest message above
rather than a cryptic `docker: 'pod' is not a docker command`.

## Why the code still says `_podman_path`

The resolver function is named `_podman_path` for historical reasons and
because the whole local-runtime family imports it — renaming it would touch
a dozen files for no behavioural gain. Despite the name it is
runtime-agnostic and returns whichever runtime wins the preference order.
`detect_runtime()` returns the runtime **name** for callers that need to
branch on capability (e.g. `runtime_supports_pods()`).
