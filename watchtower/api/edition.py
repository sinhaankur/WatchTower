"""License-tier (Free / Pro) infrastructure.

WatchTower ships open-core: the deploy/run-locally/integrations core is free
forever, while team-collaboration, observability, and HA features are gated
behind a Pro tier. The tier is currently set via the ``WATCHTOWER_TIER`` env
var (``free`` or ``pro``) and reflects whatever the operator has paid for.
When billing integration lands (Stripe / Paddle / license key), the env var
becomes "license-key-validated-against-billing-service" — same gate
mechanism, different data source. Existing endpoints don't change.

The gate is intentionally trivial today so it can be flipped on without
deploying new code:

    WATCHTOWER_TIER=pro watchtower-deploy serve

Pro endpoints depend on ``require_pro()`` which returns 402 Payment Required
with a structured detail (``{tier, feature, upgrade_url}``) when the tier is
free. The frontend renders a lock screen on top of those features instead
of letting the user click through and hit a 402 in the network tab.

Adding a Pro feature anywhere:
  1. Add the feature key to ``PRO_FEATURES`` below (gives it a stable id).
  2. Add ``Depends(require_pro("audit-log"))`` to the route.
  3. In the frontend, wrap the UI element with ``<ProLock feature="audit-log">``.

The list of features lives here so the frontend can render the right
upgrade prompt with feature-specific copy without round-tripping the
backend.
"""

from __future__ import annotations

import os
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status

from watchtower.api import util


# Stable feature identifiers — used by both backend (require_pro key) and
# frontend (<ProLock feature="...">). Changing these breaks the frontend
# lock UI; treat as a public contract.
PRO_FEATURES: dict[str, dict[str, str]] = {
    "audit-log": {
        "name": "Audit Log",
        "description": "See every who-did-what across your installation — who created a project, who triggered a deploy, who changed an env var. Required for SOC 2 / ISO 27001 evidence.",
    },
    "team-rbac": {
        "name": "Team Roles & Permissions",
        "description": "Assign owner / maintainer / viewer roles per organization. Restrict who can deploy to production vs. staging vs. preview environments.",
    },
    "multi-region-failover": {
        "name": "Multi-region Failover",
        "description": "Run the same project on a primary node and one or more standby nodes. Cloudflare Load Balancer routes traffic and fails over automatically.",
    },
    "sso": {
        "name": "Single Sign-On (SAML/OIDC)",
        "description": "Connect to Okta, Google Workspace, Azure AD, or any SAML 2.0 / OIDC provider. Centralized provisioning + SCIM-driven offboarding.",
    },
    "priority-support": {
        "name": "Priority Email Support",
        "description": "Direct email channel with a guaranteed response SLA. Includes upgrade/migration assistance and architecture review for HA setups.",
    },
}


def current_tier() -> str:
    """Return the active license tier — currently env-var driven.

    When billing lands, this becomes a lookup against the validated license
    record in the DB (or a cached call to the billing service). The
    function signature stays the same so downstream code never changes.
    """
    raw = (os.getenv("WATCHTOWER_TIER") or "free").strip().lower()
    return "pro" if raw in {"pro", "team", "enterprise"} else "free"


def is_pro() -> bool:
    return current_tier() == "pro"


def require_pro(feature_key: str):
    """FastAPI dependency that 402s if the install isn't on the Pro tier.

    Use as: ``Depends(require_pro("audit-log"))`` on the route. The
    returned dict gives the route handler access to the tier metadata
    in case it wants to log / audit / etc., but most handlers won't
    need it — they just want the gate.

    The structured detail body lets the frontend's apiClient interceptor
    distinguish "this is a Pro feature, show the upgrade card" from
    "this is a real error, show the error toast" without string-matching.
    """
    feature = PRO_FEATURES.get(feature_key)
    if feature is None:
        # Programmer error: a route asked for a feature key that isn't
        # registered. Fail loudly during dev so it's caught before
        # shipping, not silently in production.
        raise RuntimeError(
            f"require_pro() called with unknown feature key '{feature_key}'. "
            f"Add it to PRO_FEATURES in watchtower/api/edition.py."
        )

    async def dependency() -> dict[str, str]:
        if is_pro():
            return {"tier": "pro", "feature": feature_key}
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "tier": "free",
                "feature": feature_key,
                "feature_name": feature["name"],
                "feature_description": feature["description"],
                "upgrade_url": "https://github.com/sinhaankur/WatchTower#pro-features",
                "message": (
                    f"{feature['name']} is a Pro feature. Upgrade your installation "
                    "to enable it (set WATCHTOWER_TIER=pro on the host)."
                ),
            },
        )

    return dependency


# ─── Router ────────────────────────────────────────────────────────────────

router = APIRouter(prefix="/api/edition", tags=["Edition"])


@router.get("")
async def get_edition(
    request: Request,
    _current_user: dict = Depends(util.get_current_user),
) -> dict[str, Any]:
    """Return the current tier + feature flags for the authenticated user.

    Frontend uses this to:
      - Render lock badges on Pro UI elements.
      - Pre-empt 402s by hiding navigation entries the user can't reach.
      - Show "you're on Free / Pro" in the settings UI.

    Authenticated to keep tier info out of unauthenticated reachability —
    not because it's secret (curl can read /api/health) but because the
    list of Pro features double-serves as a "what's available to upsell"
    catalog and we don't need to expose that publicly.
    """
    tier = current_tier()
    return {
        "tier": tier,
        "is_pro": tier == "pro",
        "features": {
            key: {
                **meta,
                "unlocked": tier == "pro",
            }
            for key, meta in PRO_FEATURES.items()
        },
        "upgrade_url": "https://github.com/sinhaankur/WatchTower#pro-features",
    }
