"""RQ worker entry point.

Run with:

    python -m watchtower.worker

Reads ``REDIS_URL`` from env and drains the ``watchtower-builds`` queue.
Designed for production / docker-compose use; dev and desktop installs
fall back to in-process FastAPI BackgroundTasks (see watchtower.queue),
so this command is a no-op there.
"""
from __future__ import annotations

import logging
import os
import sys

from redis import Redis
from rq import Queue, Worker

# Import the watchtower package so the builder module + DB engine are loaded
# when each job runs (the queue holds string callables; resolution happens
# in this process, so the package must be importable here).
import watchtower  # noqa: F401  (side-effect import for sys.path)


def main() -> None:
    from watchtower.log_config import setup_logging
    setup_logging()
    logger = logging.getLogger(__name__)

    redis_url = os.getenv("REDIS_URL")
    if not redis_url:
        logger.error("REDIS_URL is not set; refusing to start a worker without a broker")
        sys.exit(1)

    connection = Redis.from_url(redis_url)
    try:
        connection.ping()
    except Exception:
        logger.exception("Cannot reach Redis at %s", redis_url)
        sys.exit(1)

    queue = Queue("watchtower-builds", connection=connection)
    worker = Worker([queue], connection=connection)
    logger.info("WatchTower build worker starting; draining 'watchtower-builds'")
    worker.work(with_scheduler=False, logging_level=os.getenv("LOG_LEVEL", "INFO"))


if __name__ == "__main__":
    main()
