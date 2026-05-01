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
VSCODE_EXTENSION_PACKAGE = ROOT / "vscode-extension" / "package.json"
DOCS_INDEX = ROOT / "docs" / "index.html"


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


# Patterns in docs/index.html that carry the current shipped version. The
# download link itself uses /releases/latest (auto-resolves), so only the
# display strings need to track the release tag.
DOCS_INDEX_PATTERNS = (
    (re.compile(r'(<div class="status-pill">v)[\d.]+(\s+Production Ready</div>)'),
     r'\g<1>{version}\g<2>'),
    (re.compile(r'(⬇ Download v)[\d.]+(</a>)'),
     r'\g<1>{version}\g<2>'),
)


def update_docs_index(path: Path, version: str) -> None:
    if not path.exists():
        print(f"Skipped {path.relative_to(ROOT)}: file not found")
        return
    text = path.read_text(encoding="utf-8")
    original = text
    for pattern, replacement in DOCS_INDEX_PATTERNS:
        text = pattern.sub(replacement.format(version=version), text)
    if text == original:
        print(f"Skipped {path.relative_to(ROOT)}: no version markers matched")
        return
    path.write_text(text, encoding="utf-8")
    print(f"Updated {path.relative_to(ROOT)}: version markers -> {version}")


def main() -> None:
    version = read_python_version()
    update_package_json(ROOT_PACKAGE, version)
    update_package_json(DESKTOP_PACKAGE, version)
    update_package_json(VSCODE_EXTENSION_PACKAGE, version)
    update_docs_index(DOCS_INDEX, version)
    print(f"Version sync complete: {version}")


if __name__ == "__main__":
    main()
