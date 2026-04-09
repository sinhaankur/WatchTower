#!/usr/bin/env python3
"""Compatibility entry point for deployment server.

Prefer using the installed command:
    watchtower-deploy serve
"""

from watchtower.deploy_server import main


if __name__ == "__main__":
    main()
