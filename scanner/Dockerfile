# Build from the scanner directory. Contains no deployment credentials.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium \
    SCANNER_HEADLESS=true \
    SCANNER_PROFILE=/home/node/chrome-profile \
    SCANNER_CONCURRENCY=1
USER node
# Init reaps browser children and forwards shutdown signals to the worker.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/worker.js"]
