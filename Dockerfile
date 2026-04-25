FROM node:20-alpine AS web-builder

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
