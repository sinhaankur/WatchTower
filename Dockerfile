# --platform=$BUILDPLATFORM pins the web-builder stage to the native build
# host's architecture (amd64 on GitHub Actions). web/dist is just static
# HTML/CSS/JS — platform-independent — so there's no reason to run `npm
# ci` inside QEMU-emulated arm64. Without this pin, `docker buildx build
# --platform linux/amd64,linux/arm64 .` runs the entire web-builder
# under arm64 emulation, where npm postinstall scripts that download
# native binaries (esbuild, swc, sharp) stall forever on emulated
# network calls. v1.14.3's `WatchTower Deployer / build-and-push` job
# hung for 3 hours on `RUN npm ci --legacy-peer-deps` for exactly this
# reason. With BUILDPLATFORM the same step finishes in ~30s. The final
# `COPY --from=web-builder` below brings the same dist/ output into
# both amd64 and arm64 runtime images.
FROM --platform=$BUILDPLATFORM node:20-alpine AS web-builder

WORKDIR /web
COPY web/package*.json ./
RUN npm ci --legacy-peer-deps
COPY web/ ./
RUN npm run build


FROM python:3.12-slim-bookworm

LABEL org.opencontainers.image.title="Wt" \
    org.opencontainers.image.description="Wt deployment control plane with Podman and App Center workflows" \
    org.opencontainers.image.source="https://github.com/sinhaankur/WatchTower"

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

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir .

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/health || exit 1

ENV WATCHTOWER_HOST=0.0.0.0 \
    WATCHTOWER_PORT=8000

CMD ["watchtower-deploy", "serve", "--host", "0.0.0.0", "--port", "8000"]
