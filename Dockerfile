# Lobby — server + prebuilt dashboard in one image.
#
# bun:sqlite is compiled into the Bun binary, so there is no node-gyp, no
# build-essential, and no native rebuild step. That is most of why this image is
# small and the build is fast.

# ---- client build ----------------------------------------------------------
FROM node:22-alpine AS client
WORKDIR /build
COPY apps/client/package.json apps/client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/client/ ./
# The trust documents live at the repo root and are the source for the pages under
# /legal. The build fails loudly if they are missing rather than shipping a sign-in
# screen that links to a 404 privacy policy — so they are copied where the build
# script expects to find them, three levels up from apps/client/scripts.
COPY PRIVACY.md TERMS.md SECURITY.md /
RUN npm run build

# ---- server deps -----------------------------------------------------------
FROM oven/bun:1 AS deps
WORKDIR /app
COPY apps/server/package.json apps/server/bun.lock ./
# --frozen-lockfile: a deploy must install exactly what was tested, and fail
# loudly rather than silently resolving something newer.
RUN bun install --frozen-lockfile --production

# ---- runtime ---------------------------------------------------------------
FROM oven/bun:1
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY apps/server/package.json ./
COPY apps/server/src ./src
COPY --from=client /build/dist ./public

# The database lives on a volume, never in the image layer.
RUN mkdir -p /data && chown -R bun:bun /data /app
VOLUME ["/data"]

ENV NODE_ENV=production \
    SERVER_PORT=4000 \
    DB_PATH=/data/events.db \
    STATIC_DIR=/app/public

# Never run as root.
USER bun
EXPOSE 4000

# Exec form so Bun receives SIGTERM directly rather than through a shell, which
# is what makes the graceful shutdown handler actually fire.
ENTRYPOINT ["bun", "run", "--smol", "src/index.ts"]
