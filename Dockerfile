# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS web-builder

WORKDIR /web
COPY web/package*.json ./
# BuildKit cache mount preserves npm's download cache across builds — even
# when a dependency change invalidates this layer, the tarballs we already
# pulled stay on disk and the next install is offline-fast.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline --no-audit --no-fund
COPY web/ ./
RUN npm run build


FROM python:3.12-slim-bookworm

LABEL org.opencontainers.image.title="WatchTower" \
    org.opencontainers.image.description="WatchTower deployment control plane with Podman and App Center workflows" \
    org.opencontainers.image.source="https://github.com/Node2-io/WatchTowerOps"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    rsync \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . /app
COPY --from=web-builder /web/dist /app/web/dist

# BuildKit cache mount keeps pip's wheel cache across builds. pyproject's
# `dynamic = ["version"]` (read from watchtower/__init__.py) means we
# can't cleanly separate dep install from package install, but the cache
# mount means a code-only change re-runs the install step against an
# already-warm wheel cache instead of redownloading every dep over the
# network. The cache itself never lands in the final image.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip \
    && pip install .

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/health || exit 1

ENV WATCHTOWER_HOST=0.0.0.0 \
    WATCHTOWER_PORT=8000

CMD ["watchtower-deploy", "serve", "--host", "0.0.0.0", "--port", "8000"]
