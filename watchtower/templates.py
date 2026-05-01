"""Project-template catalog — closes gap #11 from the gap-analysis snapshot.

Coolify and similar self-hosted PaaS ship dozens of one-click app
templates. Until now WatchTower required users to bring their own
repo. This file is the v1 catalog: a small but real set of widely-
used self-hosted apps, each entry a structured recipe (repo URL,
default env vars, recommended port, brief description, icon slug)
that the create-from-template endpoint can hydrate into a fresh
Project row.

The catalog is intentionally a Python module (not a JSON file)
because it's:
  * Tiny — fits in one screen, easier to review than JSON
  * Typed — dataclass + enum for category, IDE autocomplete works
  * Versionable — git diff shows real changes, not whitespace shuffles
  * Importable — tests can hit it directly without filesystem dance

Templates point at upstream repos under public licenses. Users who
want curated forks are free to copy a template into their org and
swap repo_url. v2 might add a "WatchTower-curated" badge and
maintain forks; for v1, upstream is fine.

To add a template: append an entry to TEMPLATES. The slug must be
URL-safe (matches `^[a-z][a-z0-9-]*$`) — it's the path segment in
``/api/templates/{slug}/create``.
"""

from __future__ import annotations

import enum
import re
from dataclasses import dataclass, field, asdict
from typing import Optional


class TemplateCategory(str, enum.Enum):
    AUTOMATION = "automation"
    ANALYTICS = "analytics"
    CONTENT = "content"
    MONITORING = "monitoring"
    DATABASE = "database"
    STATIC = "static"
    OTHER = "other"


@dataclass(frozen=True)
class TemplateEnvVar:
    """A pre-filled environment variable for a template-created project.

    ``value`` is a *placeholder*; the user is expected to review and
    edit before the first deploy. We mark project-specific ones
    (URLs, secrets) as ``placeholder=True`` so the SPA can highlight
    them as "you need to fill this in" rather than "this is the
    default."
    """

    key: str
    value: str
    description: str = ""
    placeholder: bool = False


@dataclass(frozen=True)
class ProjectTemplate:
    slug: str
    name: str
    description: str
    category: TemplateCategory
    repo_url: str
    repo_branch: str = "main"
    documentation_url: Optional[str] = None
    icon_slug: Optional[str] = None  # matches a built-in SVG; v1 just a text fallback
    default_env_vars: tuple[TemplateEnvVar, ...] = field(default_factory=tuple)
    memory_hint_mb: Optional[int] = None
    notes: Optional[str] = None  # extra context shown in the create dialog

    def to_dict(self) -> dict:
        d = asdict(self)
        d["category"] = self.category.value
        d["default_env_vars"] = [asdict(v) for v in self.default_env_vars]
        return d


# ── Catalog ─────────────────────────────────────────────────────────────────
#
# Six widely-used self-hosted apps for v1. Each is a real, maintained
# upstream project; the WatchTower deployment story is "clone the
# repo, let Nixpacks detect the build, deploy". Templates that need
# more (DB attachment, persistent volumes, etc) ship in v2 once we
# have those primitives.

TEMPLATES: tuple[ProjectTemplate, ...] = (
    ProjectTemplate(
        slug="n8n",
        name="n8n",
        description=(
            "Open-source workflow automation. Self-hosted alternative to "
            "Zapier — visual workflow editor, 350+ integrations, REST/webhook "
            "triggers."
        ),
        category=TemplateCategory.AUTOMATION,
        repo_url="https://github.com/n8n-io/n8n",
        repo_branch="master",
        documentation_url="https://docs.n8n.io",
        icon_slug="n8n",
        default_env_vars=(
            TemplateEnvVar(
                key="N8N_HOST",
                value="0.0.0.0",
                description="Bind to all interfaces inside the container",
            ),
            TemplateEnvVar(
                key="WEBHOOK_URL",
                value="https://your-domain.com/",
                description="Public URL for webhook callbacks — must be reachable from internet",
                placeholder=True,
            ),
            TemplateEnvVar(
                key="N8N_ENCRYPTION_KEY",
                value="<generate-with-openssl-rand-hex-32>",
                description="Encryption key for stored credentials. NEVER reuse across instances.",
                placeholder=True,
            ),
        ),
        memory_hint_mb=512,
        notes="n8n stores workflow data on disk; attach a persistent volume in v2.",
    ),
    ProjectTemplate(
        slug="plausible",
        name="Plausible Analytics",
        description=(
            "Privacy-first web analytics — no cookies, no personal data, "
            "GDPR-compliant by default. Open-source alternative to Google "
            "Analytics."
        ),
        category=TemplateCategory.ANALYTICS,
        repo_url="https://github.com/plausible/community-edition",
        repo_branch="master",
        documentation_url="https://plausible.io/docs/self-hosting",
        icon_slug="plausible",
        default_env_vars=(
            TemplateEnvVar(
                key="BASE_URL",
                value="https://analytics.your-domain.com",
                description="Public URL of your Plausible instance",
                placeholder=True,
            ),
            TemplateEnvVar(
                key="SECRET_KEY_BASE",
                value="<generate-with-openssl-rand-base64-64>",
                description="Phoenix secret-key-base. NEVER reuse.",
                placeholder=True,
            ),
        ),
        memory_hint_mb=1024,
        notes=(
            "Plausible needs Postgres + ClickHouse to run. Deploy those "
            "alongside (use the postgres template) or point the env vars at "
            "managed instances."
        ),
    ),
    ProjectTemplate(
        slug="ghost",
        name="Ghost",
        description=(
            "Modern, open-source publishing platform. Headless CMS with "
            "built-in newsletter, member subscriptions, and SEO."
        ),
        category=TemplateCategory.CONTENT,
        repo_url="https://github.com/TryGhost/Ghost",
        repo_branch="main",
        documentation_url="https://ghost.org/docs/install/",
        icon_slug="ghost",
        default_env_vars=(
            TemplateEnvVar(
                key="url",
                value="https://blog.your-domain.com",
                description="Public URL of your Ghost site",
                placeholder=True,
            ),
            TemplateEnvVar(
                key="database__client",
                value="mysql",
                description="Either 'sqlite3' (single-instance) or 'mysql' (multi-instance)",
            ),
        ),
        memory_hint_mb=512,
    ),
    ProjectTemplate(
        slug="uptime-kuma",
        name="Uptime Kuma",
        description=(
            "Self-hosted uptime monitoring tool. HTTP/TCP/ping/DNS probes, "
            "status pages, multi-channel notifications. Slick UI."
        ),
        category=TemplateCategory.MONITORING,
        repo_url="https://github.com/louislam/uptime-kuma",
        repo_branch="master",
        documentation_url="https://github.com/louislam/uptime-kuma/wiki",
        icon_slug="uptime-kuma",
        default_env_vars=(),
        memory_hint_mb=256,
        notes="No required env vars; configure monitors via the web UI after first launch.",
    ),
    ProjectTemplate(
        slug="postgres",
        name="PostgreSQL",
        description=(
            "Industry-standard relational database. Use as a backing store "
            "for Plausible, Ghost, n8n, or your own apps."
        ),
        category=TemplateCategory.DATABASE,
        # Reference repo with a Containerfile + init script. Users who
        # want a specific Postgres version can fork and edit.
        repo_url="https://github.com/sinhaankur/watchtower-templates",
        repo_branch="main",
        documentation_url="https://www.postgresql.org/docs/current/",
        icon_slug="postgres",
        default_env_vars=(
            TemplateEnvVar(
                key="POSTGRES_PASSWORD",
                value="<generate-with-openssl-rand-base64-32>",
                description="Superuser password. NEVER use the default.",
                placeholder=True,
            ),
            TemplateEnvVar(
                key="POSTGRES_USER",
                value="watchtower",
                description="Application database user",
            ),
            TemplateEnvVar(
                key="POSTGRES_DB",
                value="watchtower",
                description="Default database name",
            ),
        ),
        memory_hint_mb=512,
        notes=(
            "Postgres needs a persistent volume; raw container deploys lose "
            "data on restart. Volume management lands in v2."
        ),
    ),
    ProjectTemplate(
        slug="static-site",
        name="Static Site (Vite + nginx)",
        description=(
            "Generic static-site template — Vite for the build, nginx to "
            "serve. Drop in a React/Vue/Svelte/Astro source tree and ship."
        ),
        category=TemplateCategory.STATIC,
        repo_url="https://github.com/sinhaankur/watchtower-templates",
        repo_branch="main",
        icon_slug="static",
        default_env_vars=(),
        memory_hint_mb=128,
        notes="Smallest memory footprint. Good for landing pages and docs sites.",
    ),
)


_SLUG_RE = re.compile(r"^[a-z][a-z0-9-]*$")


def find_template(slug: str) -> Optional[ProjectTemplate]:
    """Look up a template by slug. Returns None if no match.

    Linear scan is fine — the catalog is small and explicit. A dict
    cache would shave nanoseconds while making the code less obvious.
    """
    if not slug or not _SLUG_RE.match(slug):
        return None
    for template in TEMPLATES:
        if template.slug == slug:
            return template
    return None


def all_templates() -> list[dict]:
    """Public list view used by GET /api/templates. Returns the full
    catalog as plain dicts so the API response stays JSON-clean."""
    return [t.to_dict() for t in TEMPLATES]
