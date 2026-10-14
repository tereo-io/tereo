# syntax=docker/dockerfile:1
#
# tereo. Builds from source; run from the repo root:
#
#   docker build -f docker/Dockerfile -t tereo .
#
# One image for every role: ROLE=all (default), api, or worker. The same image
# runs `./migrate-and-seed.sh` as the migrate step (compose's `migrate`
# service, or a Kubernetes Job). It carries the admin UI's build, which core
# serves at the root.

# ---------------------------------------------------------------------------
# UI: the admin UI's build (base /). No VITE_CORE_URL: the build calls core on
# its own origin.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS ui

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/tereo-ui/package.json ./packages/tereo-ui/

RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm ci --workspace=tereo-ui

COPY packages/tereo-ui ./packages/tereo-ui
# The UI build's openapi:sync copies core's bundled spec for the API docs page.
COPY packages/tereo/openapi ./packages/tereo/openapi

RUN npm run build -w tereo-ui

# ---------------------------------------------------------------------------
# Build: core, compiled with dev dependencies.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/tereo/package.json ./packages/tereo/
COPY packages/tereo/prisma.config.ts ./packages/tereo/
COPY packages/tereo/prisma ./packages/tereo/prisma/

RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm ci --workspace=tereo

RUN cd packages/tereo && npx prisma generate

COPY packages/tereo/tsconfig.json ./packages/tereo/
COPY packages/tereo/src ./packages/tereo/src

RUN npx tsc -b packages/tereo

# ---------------------------------------------------------------------------
# Runtime: production dependencies and compiled output only.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

# dumb-init for signal handling, wget for the health check.
RUN apk add --no-cache dumb-init wget

COPY package.json package-lock.json ./
COPY packages/tereo/package.json ./packages/tereo/
COPY packages/tereo/prisma.config.ts ./packages/tereo/
COPY packages/tereo/prisma ./packages/tereo/prisma/

RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm ci --workspace=tereo --omit=dev

RUN cd packages/tereo && npx prisma generate

COPY --from=build /app/packages/tereo/dist ./packages/tereo/dist
# UI_DIST_PATH's default: the UI's build beside core, as in the monorepo.
COPY --from=ui /app/packages/tereo-ui/dist ./packages/tereo-ui/dist

COPY docker/migrate-and-seed.sh ./packages/tereo/

# File storage lives on a volume; only it is writable by the app user.
RUN chmod +x packages/tereo/migrate-and-seed.sh && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    mkdir -p /app/storage/temp && \
    chown -R nodejs:nodejs /app/storage

USER nodejs

WORKDIR /app/packages/tereo

# Production unless overridden: JSON logs, secure cookies, exit on uncaught
# errors, and the PUBLIC_URL / TRUST_PROXY / CORS_ALLOWED_ORIGINS checks.
# docker-compose.yml sets development for its localhost stack.
ENV NODE_ENV=production
# Boot OpenTelemetry before any app code. A no-op without an OTLP endpoint.
ENV NODE_OPTIONS="--import ./dist/telemetry/register.js"
ENV OTEL_SERVICE_NAME="tereo"
ENV FILE_SERVICE_STORAGE_PATH="/app/storage"
ENV FILE_SERVICE_TEMP_PATH="/app/storage/temp"

VOLUME ["/app/storage"]

# ROLE=worker has no API; it answers /health on WORKER_HEALTH_PORT.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD if [ "$ROLE" = "worker" ]; then port="${WORKER_HEALTH_PORT:-4002}"; \
      else port="${PORT:-4001}"; fi; \
      wget --quiet --tries=1 --spider "http://localhost:$port/health" || exit 1

EXPOSE 4001 4002

ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "dist/index.js"]
