FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    git \
    rsync \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . /app

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir .

EXPOSE 8000

ENV WATCHTOWER_HOST=0.0.0.0 \
    WATCHTOWER_PORT=8000

CMD ["watchtower-deploy", "serve", "--host", "0.0.0.0", "--port", "8000"]
