# jpexs-web backend: Node + Java + FFDec CLI (Linux).
# Build: docker build -t jpexs-web .
# Run:   docker run --rm -p 3000:3000 jpexs-web
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    FFDEC_VERSION=26.2.1 \
    FFDEC_BIN=/opt/ffdec/ffdec.sh \
    WORK_DIR=/data/work \
    PORT=3000

RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-17-jre-headless unzip curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/ffdec /data/work /app \
 && curl -fsSL -o /tmp/ffdec.zip \
      "https://github.com/jindrapetrik/jpexs-decompiler/releases/download/version${FFDEC_VERSION}/ffdec_${FFDEC_VERSION}.zip" \
 && unzip -q /tmp/ffdec.zip -d /opt/ffdec \
 && rm /tmp/ffdec.zip \
 && chmod +x /opt/ffdec/ffdec.sh \
 && /opt/ffdec/ffdec.sh -help >/dev/null 2>&1 || /opt/ffdec/ffdec.sh -version || true

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["node", "server.js"]
