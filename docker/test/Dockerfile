# syntax=docker/dockerfile:1
# Integration-test runner for tereo: dev dependencies installed, the
# source copied, and the test suite as the command. Driven by docker/test/run.sh.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/tereo/package.json ./packages/tereo/
COPY packages/tereo/prisma.config.ts ./packages/tereo/
COPY packages/tereo/prisma ./packages/tereo/prisma/

RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm ci --workspace=tereo

RUN cd packages/tereo && npx prisma generate

COPY packages/tereo ./packages/tereo

WORKDIR /app/packages/tereo

# globalSetup migrates and seeds the database itself.
CMD ["npx", "vitest", "run"]
