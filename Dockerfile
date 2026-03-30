FROM mcr.microsoft.com/playwright/python:v1.58.0-noble

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg git docker.io docker-compose-v2 \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && npm i -g @openai/codex@latest \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/package-lock.json /app/backend/
WORKDIR /app/backend
RUN npm ci --include=dev

COPY backend/ /app/backend/
RUN npm run build && npm prune --omit=dev

COPY worker/requirements.txt /app/worker/requirements.txt
WORKDIR /app/worker
RUN python -m pip install --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY worker/ /app/worker/
COPY docker/start-services.sh /app/docker/start-services.sh

RUN chmod +x /app/docker/start-services.sh

WORKDIR /app
ENV NODE_ENV=production
RUN mkdir -p /tmp/browser-agent-shopware
EXPOSE 3000

CMD ["/app/docker/start-services.sh"]
