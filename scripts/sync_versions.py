#!/usr/bin/env python3
"""Synchronize version fields across WatchTower package manifests."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INIT_FILE = ROOT / "watchtower" / "__init__.py"
ROOT_PACKAGE = ROOT / "package.json"
DESKTOP_PACKAGE = ROOT / "desktop" / "package.json"


def read_python_version() -> str:
    content = INIT_FILE.read_text(encoding="utf-8")
    match = re.search(r'__version__\s*=\s*"([^"]+)"', content)
    if not match:
        raise RuntimeError("Could not find __version__ in watchtower/__init__.py")
    return match.group(1)


def update_package_json(path: Path, version: str) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    old = data.get("version")
    data["version"] = version
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"Updated {path.relative_to(ROOT)}: {old} -> {version}")


def main() -> None:
    version = read_python_version()
    update_package_json(ROOT_PACKAGE, version)
    update_package_json(DESKTOP_PACKAGE, version)
    print(f"Version sync complete: {version}")


if __name__ == "__main__":
    main()
