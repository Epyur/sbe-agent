FROM node:20-slim

# Chromium для puppeteer (mermaid-cli рендерит диаграммы через него).
# PUPPETEER_SKIP_DOWNLOAD=true — не качаем бандл-браузер, используем системный.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json render.js ./
RUN npm install --omit=dev && npm cache clean --force

EXPOSE 3000
CMD ["node", "render.js"]
