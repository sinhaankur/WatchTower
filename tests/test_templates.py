"""Project-template catalog endpoint tests.

Covers the two endpoints + shape invariants on the catalog itself
so the SPA's render code can rely on the response keys.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from watchtower import templates as template_catalog


# ── Catalog shape invariants ─────────────────────────────────────────────────

def test_catalog_has_at_least_one_template():
    """v1 ships 6, but the test only requires "at least 1" so we
    don't have to update it every time we add a template."""
    assert len(template_catalog.TEMPLATES) >= 1


def test_every_template_slug_matches_url_safe_pattern():
    """The slug is a path segment in /api/templates/{slug}/create —
    if it has unsafe chars, FastAPI's route matching breaks."""
    import re
    pattern = re.compile(r"^[a-z][a-z0-9-]*$")
    for tpl in template_catalog.TEMPLATES:
        assert pattern.match(tpl.slug), f"bad slug: {tpl.slug}"


def test_every_template_has_required_fields():
    """A template missing any of these would 500 the API — pin them
    server-side rather than depending on TypeScript at the SPA edge."""
    for tpl in template_catalog.TEMPLATES:
        d = tpl.to_dict()
        for key in ("slug", "name", "description", "category", "repo_url", "repo_branch"):
            assert d.get(key), f"{tpl.slug}: missing {key}"


def test_template_to_dict_serializes_env_vars_as_dicts():
    """Pin the response shape — the SPA's TypeScript types depend
    on env_vars being an array of objects, not dataclass instances."""
    for tpl in template_catalog.TEMPLATES:
        d = tpl.to_dict()
        for env in d["default_env_vars"]:
            assert isinstance(env, dict)
            assert "key" in env
            assert "value" in env


def test_find_template_returns_none_for_bad_slug():
    assert template_catalog.find_template("../../../etc/passwd") is None
    assert template_catalog.find_template("UPPERCASE") is None
    assert template_catalog.find_template("with spaces") is None
    assert template_catalog.find_template("") is None
    assert template_catalog.find_template("does-not-exist") is None


def test_find_template_finds_known_slug():
    n8n = template_catalog.find_template("n8n")
    assert n8n is not None
    assert n8n.slug == "n8n"


# ── Endpoint tests ───────────────────────────────────────────────────────────

def test_list_templates_returns_full_catalog(client: TestClient):
    r = client.get("/api/templates")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "templates" in body
    assert len(body["templates"]) == len(template_catalog.TEMPLATES)
    # First entry has the keys the SPA depends on.
    first = body["templates"][0]
    for key in ("slug", "name", "description", "category", "repo_url", "default_env_vars"):
        assert key in first


def test_list_templates_requires_auth(anon_client: TestClient):
    r = anon_client.get("/api/templates")
    assert r.status_code == 401


def test_create_from_template_creates_project_with_prefilled_env_vars(client: TestClient):
    r = client.post(
        "/api/templates/n8n/create",
        json={"name": "my-n8n-instance"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["project_id"]
    assert body["name"] == "my-n8n-instance"
    assert body["repo_url"] == "https://github.com/n8n-io/n8n"
    assert body["template"]["slug"] == "n8n"
    # n8n's default_env_vars include WEBHOOK_URL + N8N_ENCRYPTION_KEY
    # both flagged as placeholders — the response should surface them.
    assert "WEBHOOK_URL" in body["placeholder_env_var_keys"]
    assert "N8N_ENCRYPTION_KEY" in body["placeholder_env_var_keys"]
    # Three env vars (N8N_HOST + WEBHOOK_URL + N8N_ENCRYPTION_KEY)
    # should have been created.
    assert len(body["env_var_ids"]) == 3


def test_create_from_template_supports_repo_branch_override(client: TestClient):
    r = client.post(
        "/api/templates/uptime-kuma/create",
        json={"name": "my-uptime-kuma", "repo_branch": "feature/foo"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["repo_branch"] == "feature/foo"


def test_create_from_template_supports_repo_url_override(client: TestClient):
    r = client.post(
        "/api/templates/n8n/create",
        json={
            "name": "my-fork",
            "repo_url_override": "https://github.com/myorg/n8n-fork",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["repo_url"] == "https://github.com/myorg/n8n-fork"


def test_create_from_unknown_slug_returns_404(client: TestClient):
    r = client.post(
        "/api/templates/does-not-exist/create",
        json={"name": "x"},
    )
    assert r.status_code == 404
    assert "does-not-exist" in r.json()["detail"]


def test_create_from_template_rejects_path_traversal_slug(client: TestClient):
    r = client.post(
        "/api/templates/..%2F..%2Fetc%2Fpasswd/create",
        json={"name": "x"},
    )
    # FastAPI's path-segment escape interprets the encoded slashes as
    # part of the path, so the slug doesn't match the route's pattern
    # and we get 404, 405 (route exists but with a different shape),
    # or 422 (validation). All three are correct rejections — what we
    # don't want is a 500 or a 201 with a path-traversal-poisoned project.
    assert r.status_code in (404, 405, 422)


def test_create_from_template_requires_name(client: TestClient):
    r = client.post(
        "/api/templates/n8n/create",
        json={},
    )
    # Missing required field — pydantic returns 422.
    assert r.status_code == 422


def test_create_from_template_requires_auth(anon_client: TestClient):
    r = anon_client.post(
        "/api/templates/n8n/create",
        json={"name": "x"},
    )
    assert r.status_code == 401
