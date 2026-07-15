#!/usr/bin/env python3
"""Payload signing + fingerprint toolbox for the two-stage desktop updater.

Used by scripts/build-payload.sh, scripts/build-python-bundle.sh,
scripts/preflight.sh, scripts/verify-release.sh, and the release CI job.
Design: docs/DESKTOP_TWO_STAGE_UPDATER.md.

Subcommands:
  fingerprint [requirements.txt]   sha256 of the NORMALIZED requirements file
  sha256 <file>                    sha256 of a file's raw bytes
  keygen --out-private P --out-public Q
                                   generate an Ed25519 keypair (PEM)
  sign <file> (--key PEM_PATH | --key-env ENV_NAME)
                                   print base64 Ed25519 signature over the bytes
  verify <file> --pub PEM_PATH --signature B64
                                   exit 0 iff the signature is valid
  manifest --version V --min-shell-version M --requirements-sha S
           --key-id K --tarball T [--signature B64]
                                   print the payload-manifest.json document

`fingerprint` and `sha256` need only the stdlib so they run on any python3
(build-python-bundle.sh calls them from CI runners with no venv). The
signing subcommands import `cryptography` lazily — it's already a core
watchtower dependency, so every dev venv and the CI job have it.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
from pathlib import Path


def normalized_requirements(path: Path) -> bytes:
    """Canonical form of a requirements file for fingerprinting.

    Strips comments/blank lines and sorts, so cosmetic edits (reordering,
    comment rewording) don't change the fingerprint — but ANY change to the
    actual dependency set does, which is what forces payload consumers onto
    the full-installer path after a dep change.
    """
    lines = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            lines.append(line)
    return ("\n".join(sorted(lines)) + "\n").encode("utf-8")


def cmd_fingerprint(args: argparse.Namespace) -> int:
    print(hashlib.sha256(normalized_requirements(Path(args.requirements))).hexdigest())
    return 0


def cmd_sha256(args: argparse.Namespace) -> int:
    h = hashlib.sha256()
    with open(args.file, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    print(h.hexdigest())
    return 0


def _load_private_key_pem(pem: bytes):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    key = load_pem_private_key(pem, password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise SystemExit("ERROR: key is not Ed25519 — refusing to sign")
    return key


def cmd_keygen(args: argparse.Namespace) -> int:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import (
        Encoding,
        NoEncryption,
        PrivateFormat,
        PublicFormat,
    )

    priv_path = Path(args.out_private)
    pub_path = Path(args.out_public)
    if priv_path.exists() and not args.force:
        raise SystemExit(
            f"ERROR: {priv_path} already exists — refusing to overwrite a signing key "
            "(pass --force only if you are deliberately rotating)"
        )
    key = Ed25519PrivateKey.generate()
    priv_path.parent.mkdir(parents=True, exist_ok=True)
    priv_path.write_bytes(
        key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    )
    os.chmod(priv_path, 0o600)
    pub_path.write_bytes(
        key.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
    )
    print(f"private key: {priv_path} (0600 — keep OUT of the repo)")
    print(f"public key:  {pub_path}")
    return 0


def cmd_sign(args: argparse.Namespace) -> int:
    if args.key_env:
        pem = os.environ.get(args.key_env, "")
        if not pem.strip():
            raise SystemExit(f"ERROR: env var {args.key_env} is empty or unset")
        pem_bytes = pem.encode("utf-8")
    else:
        pem_bytes = Path(args.key).read_bytes()
    key = _load_private_key_pem(pem_bytes)
    data = Path(args.file).read_bytes()
    print(base64.b64encode(key.sign(data)).decode("ascii"))
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    from cryptography.hazmat.primitives.serialization import load_pem_public_key

    pub = load_pem_public_key(Path(args.pub).read_bytes())
    if not isinstance(pub, Ed25519PublicKey):
        raise SystemExit("ERROR: public key is not Ed25519")
    data = Path(args.file).read_bytes()
    try:
        pub.verify(base64.b64decode(args.signature), data)
    except (InvalidSignature, ValueError):
        print("signature: INVALID", file=sys.stderr)
        return 1
    print("signature: OK")
    return 0


def cmd_manifest(args: argparse.Namespace) -> int:
    tarball = Path(args.tarball)
    h = hashlib.sha256()
    with open(tarball, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    doc = {
        "version": args.version,
        "minShellVersion": args.min_shell_version,
        "requirementsSha256": args.requirements_sha,
        "sha256": h.hexdigest(),
        "signature": args.signature or "",
        "keyId": args.key_id,
        "sizeBytes": tarball.stat().st_size,
    }
    print(json.dumps(doc, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("fingerprint")
    p.add_argument("requirements", nargs="?", default="requirements.txt")
    p.set_defaults(func=cmd_fingerprint)

    p = sub.add_parser("sha256")
    p.add_argument("file")
    p.set_defaults(func=cmd_sha256)

    p = sub.add_parser("keygen")
    p.add_argument("--out-private", required=True)
    p.add_argument("--out-public", required=True)
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_keygen)

    p = sub.add_parser("sign")
    p.add_argument("file")
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--key", help="path to Ed25519 private key PEM")
    group.add_argument("--key-env", help="env var holding the private key PEM contents")
    p.set_defaults(func=cmd_sign)

    p = sub.add_parser("verify")
    p.add_argument("file")
    p.add_argument("--pub", required=True)
    p.add_argument("--signature", required=True)
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("manifest")
    p.add_argument("--version", required=True)
    p.add_argument("--min-shell-version", required=True)
    p.add_argument("--requirements-sha", required=True)
    p.add_argument("--key-id", required=True)
    p.add_argument("--tarball", required=True)
    p.add_argument("--signature", default="")
    p.set_defaults(func=cmd_manifest)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
