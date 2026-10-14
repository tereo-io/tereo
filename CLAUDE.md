# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

**Tereo** (`tereo`) is a reusable application core — auth, file storage, webhooks, notifications,
audit logging. It is deployed **once per app**, never as a shared instance: each app gets its own
core, database, signing keys, admin user, and buckets.

It is **one service** — `packages/tereo`, port 4001 — with one Postgres database (a schema
per area: `auth`, `files`, `webhooks`, `notifications`, `audit`, plus `core` for the outbox). The
other packages are `@tereo-io/sdk`, which app services use to reach core, and the admin UI,
`packages/tereo-ui` (Vite + React, port 4000 in development), which calls core directly and is
built on [`@kosmeo-ui/react`](https://github.com/kosmeo-ui/kosmeo-ui) from npm. Its production build ships in
core's image and core serves it at `/`, around core's API under `/v1`.
Outbound HTTP goes through the request handler [`@dianemo/core`](https://github.com/dianemo/dianemo).

Read [README.md](README.md) first; its *Current state* section lists what is done and what is not.

## How app services fit in

- App services **register** their permissions, system roles, buckets and event types at boot, under
  their namespace; requested access waits for an admin; dropped items retire (`utils/registry.ts`,
  [docs/registry.md](packages/tereo/docs/registry.md)).
- First launch: core generates its keys into `core.secrets` and logs a setup token until
  `POST /v1/setup` creates the first admin, through the admin UI's setup screen.
- App services use **one SDK, `@tereo-io/sdk`** (`packages/tereo-sdk`): `createCoreClient` over one set
  of credentials, `register()` at boot, and `core.outbox` for audit entries and events in the app's
  own transactions.


## Layout of `packages/tereo`

One ordinary package, shared by every area:

| Path | Holds |
|------|-------|
| `src/index.ts` / `app.ts` / `worker.ts` | Entry point, Express app, background work. `ROLE` = `all` / `api` / `worker` |
| `src/env.ts` | The one env schema. `src/preload.ts` must be the first import of every entry point |
| `src/telemetry/` | OpenTelemetry, loaded with `--import` before the app (see `docs/telemetry.md`) |
| `src/definitions/` | Core's own declaration (`CORE_DECLARATION`: permissions, system roles, buckets, event types — registered on every start), its service row and reserved namespaces, default org, system user |
| `src/routes/` | Mirrors the URL. `index.ts` is the root: `health/`, `oauth/` and `well-known/` at the root, core's own API under `v1/` (`account/`, `admin/`, `setup/`, `files/`, `webhooks/`, `notifications/`, `audit/`, `registry/`), and last the admin UI's build, served at `/` |
| `src/middleware/`, `src/utils/`, `src/utils/db/`, `src/jobs/` | Shared. `db` is one object across all tables |
| `src/websocket/` | socket.io on `/ws` (Redis adapter): pushes permission changes to signed-in users |
| `src/cli/` | Operator commands, `npm run cli -- <command>` (e.g. `rewrap-master-key`) |
| `src/scripts/seed.ts` | Idempotent seed, run after every migrate |
| `src/tests/` | One suite against one server; area subfolders |
| `docs/` | Per-area reference notes |

## Key conventions

- **Style is enforced by CI** ([docs/code-style.md](docs/code-style.md)): Prettier, import order
  (single-line imports longest first, then multi-line — `npm run sort-imports`), ESLint, `tsc`. Run
  `npm run format && npm run sort-imports && npm run lint` before committing. A change to `@tereo-io/sdk`, or
  to `tereo` or `tereo-ui` (one release group, `core`, whose version tags the image), needs a
  version plan (`npm run version-plan`).
- **ESM only.** Every package is `"type": "module"` with `.js` extensions on all relative imports,
  including directory imports (`./oauth/index.js`, not `./oauth`).
- **Route layout** (`routes` skill; `tests/unit/routeLayout.test.ts`): folders mirror the URL; each
  `index.ts` is one router and only wires routes; handlers in `controllers.ts`, Zod in `schemas.ts`,
  route-local middleware in `middleware.ts`; every `:param` is mounted from its own singular folder
  (`/webhooks/:id` → `webhooks/webhook/`); register static paths, then `:param` mounts, then `/`.
- **Validation**: always Zod — `validateBody/Params/Query` from `utils/validateReq.ts`, Zod schemas for
  env vars.
- **Errors**: use the error classes from `utils/errors.ts` — never `res.status(400).json(...)` directly.
- **Auth**: `requireAuth` + `requirePermission()` from `middleware/auth.ts` on all protected routes.
  Tokens are verified in-process. Permissions are hierarchical (`utils/permissions.ts`) — `write`
  includes `read`, `archive` includes `write`, `delete` includes `archive`, `admin` includes all. There is no test-mode shortcut: tests use real users and
  tokens from `tests/utils/principals.ts`.
- **Declared, not seeded**: core's permissions, system roles, buckets and event types live in
  `definitions/` and are registered on start (`registerCore()`); removing one there retires it a day
  later. Admins never create permissions or edit system roles. Tests make their own under the test
  service (`tests/utils/testService.ts`), never under core, whose declaration would retire them.
- **Actors**: every "who" column (`created_by`, `user_id`, `writer_user_id`, …) is a foreign key into
  `auth.users`. Clients act as their service-account user; core acts as `SYSTEM_USER_ID`
  (`definitions/systemUser.ts`). Users and organizations are deactivated or archived, never deleted.
- **Audit and webhooks**: in the mutation's transaction, call `logAuditTx(tx, …)` (inserts the entry
  directly) and `emitTx(tx, …)` (writes `core.outbox`; the worker's reaper fans it out) from
  `utils/outbox.ts`. Event types must be listed in `definitions/eventTypes.ts`.
- **Migrations**: generated by Prisma (`migrate dev --create-only`), with raw SQL appended only for
  what Prisma cannot express — range partitioning, partial and opclass indexes, CHECK constraints. On
  the partitioned tables (`audit_log_entries`, `webhook_deliveries`, and `notifications` and
  `deliveries` in the `notifications` schema) Prisma will emit a PK-reset statement Postgres
  rejects; delete only that statement.
- **Raw SQL** names tables with their schema (`"files"."objects"`) — there is no `public` schema.
- **Logging**: JSON via Pino, object first (`logger.info({ meta }, "msg")`), with `request_id` added
  during a request and `trace_id`/`span_id` during traced ones. Errors go under `err`
  (`logger.error({ err }, "msg")`), which Pino serializes with its stack.

## Local development

```sh
npm install
docker compose up -d postgres redis           # host ports 5442 / 6389
cp packages/tereo/.env.example packages/tereo/.env   # no keys needed
cd packages/tereo
npx prisma generate && npx prisma migrate deploy && npx tsx src/scripts/seed.ts
npm run dev                                   # http://localhost:4001
npx vitest run                                # uses <db>_test and Redis db 1 (TEST_DATABASE_URL overrides)
```

The admin UI in development (core's `UI_BASE_URL` defaults to :4000 outside production):

```sh
cd packages/tereo-ui                          # cp .env.example .env.development.local
npm run dev                                   # http://localhost:4000, calling core on :4001
```

`docker compose up` builds the image from source — the UI included — runs `migrate` (migrations +
seed) and then core, with the UI at http://localhost:4001. `docker/test/run.sh` runs the suite in
an isolated stack, against a fixture UI build. Neither needs a `.env`.

**URL layout**: core's own API is under `/v1` (`routes/v1/`); `/oauth`, `/.well-known`, `/health`
and `/ws` stay at the root. The admin UI takes every other path — `RESERVED_PREFIXES` in
`utils/ui.ts` lists core's (the UI's `check` script keeps its routes clear of them).

**The UI under core** is built with base `/` and served from `UI_DIST_PATH` (default
`packages/tereo-ui/dist`; skipped with a log line when absent). `UI_BASE_URL` — redirects,
CORS default, share unlock page, and the login client's `${UI_BASE_URL}/callback` — defaults to
`PUBLIC_URL` in production; compose sets it to `http://localhost:4001`.

**API docs** (`/docs` in the UI) render `packages/tereo/openapi/bundled-openapi.yaml`, which
the UI's `openapi:sync` (run by its `dev` and `build`) copies into `public/openapi/` — gitignored, and
only a warning when the source is missing. The page is lazy-loaded; Redoc stays out of the main bundle.

**Keys** come from env if set, otherwise from `core.secrets`, generated on first start —
`loadKeys()` (`utils/keys.ts`) must run before anything signs, verifies or decrypts. The seed creates
no person; the first admin comes from setup (`utils/setup.ts`). App services are added with
`POST /v1/admin/services` and register with `POST /v1/registry/declaration`.

`@tereo-io/sdk` depends on the published `@dianemo/core` `^2.0.0`. Nothing in `tereo`
depends on it.

## What not to do

- Do not add external API integrations here. They belong in
  [dianemo-plugins](https://github.com/dianemo/dianemo-plugins).
- Do not reintroduce a vendored copy of the request handler. Depend on `@dianemo/core`.
