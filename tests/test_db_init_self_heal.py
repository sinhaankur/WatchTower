from alembic.util.exc import CommandError

from watchtower import database as db


class _FakeInspector:
    def get_table_names(self):
        return ["alembic_version", "projects"]


def test_init_db_self_heals_missing_revision(monkeypatch):
    monkeypatch.setattr(db, "inspect", lambda _engine: _FakeInspector())
    monkeypatch.setattr(db, "_head_from_version_files", lambda: None)
    monkeypatch.setattr(db, "_current_alembic_version", lambda: "d8a14e9b7235")
    monkeypatch.setattr(db, "_alembic_config", lambda: object())

    calls = []

    def fake_upgrade(_cfg, rev):
        calls.append(("upgrade", rev))
        if calls.count(("upgrade", "head")) == 1:
            raise CommandError("Can't locate revision identified by 'd8a14e9b7235'")

    def fake_stamp(_cfg, rev):
        calls.append(("stamp", rev))

    monkeypatch.setattr("alembic.command.upgrade", fake_upgrade)
    monkeypatch.setattr("alembic.command.stamp", fake_stamp)

    db.init_db()

    assert calls == [
        ("upgrade", "head"),
        ("stamp", "head"),
        ("upgrade", "head"),
    ]


def test_init_db_does_not_self_heal_mismatched_revision(monkeypatch):
    monkeypatch.setattr(db, "inspect", lambda _engine: _FakeInspector())
    monkeypatch.setattr(db, "_head_from_version_files", lambda: None)
    monkeypatch.setattr(db, "_current_alembic_version", lambda: "some_other_rev")
    monkeypatch.setattr(db, "_alembic_config", lambda: object())

    calls = []

    def fake_upgrade(_cfg, rev):
        calls.append(("upgrade", rev))
        raise CommandError("Can't locate revision identified by 'd8a14e9b7235'")

    def fake_stamp(_cfg, rev):
        calls.append(("stamp", rev))

    monkeypatch.setattr("alembic.command.upgrade", fake_upgrade)
    monkeypatch.setattr("alembic.command.stamp", fake_stamp)

    try:
        db.init_db()
        assert False, "Expected CommandError"
    except CommandError:
        pass

    assert calls == [("upgrade", "head")]


def test_missing_revision_parser():
    assert db._missing_revision_from_alembic_error(
        "Can't locate revision identified by 'd8a14e9b7235'"
    ) == "d8a14e9b7235"
    assert db._missing_revision_from_alembic_error(
        "No such revision or branch 'd8a14e9b7235'"
    ) == "d8a14e9b7235"
    assert db._missing_revision_from_alembic_error("some other failure") is None


def test_head_from_version_files_matches_real_alembic_head():
    """The init_db fast path trusts _head_from_version_files() to decide
    "already up to date — skip alembic entirely". If the file scan
    computes a *stale* head (it once only parsed unannotated, hex-only
    revision ids), existing DBs sitting at that stale revision silently
    stop receiving migrations. Pin the scan to Alembic's real head so
    any future template/style change in alembic/versions/*.py that the
    regexes can't read fails loudly here instead of in users' DBs.
    """
    from alembic.config import Config
    from alembic.script import ScriptDirectory
    from pathlib import Path

    repo_root = Path(db.__file__).resolve().parents[1]
    cfg = Config(str(repo_root / "alembic.ini"))
    cfg.set_main_option("script_location", str(repo_root / "alembic"))
    real_head = ScriptDirectory.from_config(cfg).get_current_head()

    assert db._head_from_version_files() == real_head
