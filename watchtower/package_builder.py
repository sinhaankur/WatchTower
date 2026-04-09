"""Create portable deployment bundles for Linux and other device targets."""

from __future__ import annotations

import argparse
import json
import tarfile
import time
import zipfile
from pathlib import Path

EXCLUDES = {".git", "__pycache__", ".venv", "node_modules"}


def should_exclude(path: Path) -> bool:
    return any(part in EXCLUDES for part in path.parts)


def collect_files(source_dir: Path) -> list[Path]:
    files: list[Path] = []
    for item in source_dir.rglob("*"):
        if item.is_file() and not should_exclude(item.relative_to(source_dir)):
            files.append(item)
    return files


def write_manifest(
    source_dir: Path,
    output_dir: Path,
    app_name: str,
    target: str,
    package_format: str,
    file_count: int,
) -> Path:
    manifest = {
        "app_name": app_name,
        "target": target,
        "format": package_format,
        "source_dir": str(source_dir),
        "file_count": file_count,
        "created_epoch": int(time.time()),
    }
    manifest_path = output_dir / f"{app_name}.manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest_path


def build_archive(
    source_dir: Path,
    output_dir: Path,
    app_name: str,
    package_format: str,
    files: list[Path],
) -> Path:
    if package_format == "tar.gz":
        archive_path = output_dir / f"{app_name}.tar.gz"
        with tarfile.open(archive_path, "w:gz") as tar:
            for file_path in files:
                arcname = file_path.relative_to(source_dir)
                tar.add(file_path, arcname=str(arcname))
        return archive_path

    archive_path = output_dir / f"{app_name}.zip"
    with zipfile.ZipFile(
        archive_path, "w", compression=zipfile.ZIP_DEFLATED
    ) as zf:
        for file_path in files:
            arcname = file_path.relative_to(source_dir)
            zf.write(file_path, arcname=str(arcname))
    return archive_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build portable app deployment bundle"
    )
    parser.add_argument("--name", required=True, help="Application name")
    parser.add_argument(
        "--source", required=True, help="Source directory to package"
    )
    parser.add_argument(
        "--output",
        default="./dist-packages",
        help="Output directory for generated package",
    )
    parser.add_argument(
        "--target",
        default="linux",
        choices=["linux", "windows", "macos", "any"],
        help="Target device/platform for this package",
    )
    parser.add_argument(
        "--format",
        default="tar.gz",
        choices=["tar.gz", "zip"],
        help="Archive format",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source_dir = Path(args.source).resolve()
    output_dir = Path(args.output).resolve()

    if not source_dir.exists() or not source_dir.is_dir():
        raise SystemExit(f"Invalid source directory: {source_dir}")

    output_dir.mkdir(parents=True, exist_ok=True)
    files = collect_files(source_dir)
    archive_path = build_archive(
        source_dir=source_dir,
        output_dir=output_dir,
        app_name=args.name,
        package_format=args.format,
        files=files,
    )
    manifest_path = write_manifest(
        source_dir=source_dir,
        output_dir=output_dir,
        app_name=args.name,
        target=args.target,
        package_format=args.format,
        file_count=len(files),
    )

    print(json.dumps({
        "archive": str(archive_path),
        "manifest": str(manifest_path),
        "files": len(files),
        "target": args.target,
    }, indent=2))


if __name__ == "__main__":
    main()
