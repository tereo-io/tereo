---
name: test
description: Testing patterns for tereo — the Vitest integration suite that runs one real server against a dedicated test database with real users and tokens, plus core's and the SDK's unit tests. Use when writing tests, running the suite, or debugging test failures.
paths:
  - packages/tereo/src/tests/**
  - packages/tereo/vitest.config.ts
  - packages/tereo-sdk/src/tests/**
  - docker/test/**
---

# Testing Patterns

## Running Tests

```sh
cd packages/tereo
npx vitest run                                        # whole suite (npm run test:local)
npx vitest run src/tests/webhooks/webhooks.test.ts    # one file
npx vitest run -t "rotates the signing secret"        # by test name
npx vitest run src/tests/unit                         # core's unit tests (globalSetup still runs: needs Postgres/Redis)
npx vitest                                            # watch (npm run test:watch)
npx vitest run --coverage                             # npm run test:coverage

docker/test/run.sh             # from the repo root: isolated Docker stack, then torn down
                               # (`npm test` in the package runs this; CI runs `nx affected -t test:docker`)

cd packages/tereo-sdk && npx vitest run     # SDK unit tests, no server or database
```

## Setup Requirements

- Local runs read `packages/tereo/.env` (`cp .env.example .env` — no keys needed). Missing
  `.env` fails at startup with a clear error. `docker/test/run.sh` needs no `.env` (`DOCKER_TEST=true`).
- Postgres and Redis must be up: `docker compose up -d postgres redis` (host ports 5442 / 6389).
- `src/tests/testEnv.ts` points the suite at **`<db>_test`** and **Redis db 1**, so dev data is never
  touched. `TEST_DATABASE_URL` / `TEST_REDIS_URL` (shell or `.env`) override; `NODE_ENV=test`,
  `LOG_LEVEL=silent`.
- `globalSetup.ts` runs `prisma migrate deploy` and the seed against the test database, registers
  core's declaration, seeds the fixtures, marks first-launch setup complete, then **starts one server on
  port 4001** that every file talks to. Stop `npm run dev` first — it holds the same port.
- Files run **serially** (`fileParallelism: false`): they share one server and database.

## Test File Location

```
packages/tereo/src/tests/
├── {area}/                     # auth/, files/, webhooks/, audit/, registry/, setup/, keys/
│   ├── {resource}.test.ts
│   └── utils/test-helpers.ts   # BASE_URL, HTTP_STATUS, area token helper, create/cleanup helpers
├── utils/
│   ├── principals.ts           # Real users, orgs, roles and access tokens
│   └── testService.ts          # The service that owns test-made permissions and event types
├── integration.test.ts         # Cross-area behaviour (audit in-tx, outbox → webhook fan-out)
├── health.test.ts
├── setup.ts                    # Per-file: Redis, Prisma, loadKeys(), rate-limit key reset
├── globalSetup.ts              # Once: migrate, seed, fixtures, start the server
└── testEnv.ts                  # Derives the test env from .env
```

## Auth in Tests

**There is no test-mode token.** Every token is a real signed JWT with a stored `access_tokens` row,
verified by `requireAuth` exactly as in production; permissions come from a role assigned to a real
user.

```typescript
const token = await getTestPrincipalToken({
  permissions: ["webhooks.write"],
  organizationId: "00000000-0000-7002-0000-000000000001", // or a label: "other-org-1"; null = no org
  userId: FIXTURE_USER_IDS[0], // optional — omit for a fresh user
});
```

- `getTestPrincipalToken` (`tests/utils/principals.ts`) upserts the user, the organization
  (`testOrgId(label)` maps any label to a stable UUID) and a `test-perms-<hash>` role holding the
  permissions. Tokens are cached per (user, org, permissions) within a file.
- A user's permissions are the **union of their roles** — two token requests for the same user with
  different permission sets give that user both. Use a fresh user (the default) for a narrower set.
- Area helpers wrap it: `getTestAccessToken()` in `webhooks/` (`webhooks.admin`, org-scoped),
  `files/` (`file-service.admin`), `audit/` (`audit-logs.admin`). Auth tests log in for real:
  `createAdminUser()` + `getAccessTokenForUser(user, client)` drive `/oauth/authorize` → `/oauth/token`.
- Fixed ids: `FIXTURE_USER_IDS`, `FIXTURE_ORGANIZATION_IDS` (created by `globalSetup`),
  `DEFAULT_ORGANIZATION_ID` and `SYSTEM_USER_ID` from `src/definitions/index.js`.
- Permissions, roles and event types a test needs that core doesn't declare are owned by the **test
  service** (`ensurePermission(name)`, `createTestEventType()`), never by core — core's declaration
  would retire them.
- `@tereo-io/sdk` has a `test-token-…` parser and stubs, behind `createCoreClient({ testMode: true })`, for **app services'**
  tests. Core's server accepts neither.

## Integration Test Pattern

```typescript
import { getTestPrincipalToken } from "../utils/principals.js";
import { describe, it, expect, afterAll } from "vitest";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestEventType,
  cleanupTestEntities,
} from "./utils/test-helpers.js";

describe("POST /v1/webhooks/webhooks", () => {
  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("returns 403 without webhooks.write", async () => {
    const readToken = await getTestPrincipalToken({
      organizationId: "00000000-0000-7002-0000-000000000001",
      permissions: ["webhooks.read"],
    });
    const et = await createTestEventType();

    const response = await axios.post(
      `${BASE_URL}/webhooks`,
      { url: "https://example.com/hook", eventTypes: [et.eventType] },
      {
        headers: { Authorization: `Bearer ${readToken}` },
        validateStatus: () => true,
      }
    );

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
  });
});
```

`validateStatus: () => true` makes axios return every status so the test asserts on it; errors come
back as `{ error, error_description }`.

## Asserting Side Effects

Tests may read the test database through `prisma` (`src/utils/db/prisma.js`) to check what the API
can't show:

- **Audit**: `prisma.auditLogEntry.findFirst({ where: { entityId, entityType } })` →
  `action`, `source: "tereo"`, `writerUserId: SYSTEM_USER_ID`.
- **Webhook events**: subscribe an endpoint to the event type, trigger the mutation, then
  `waitFor(() => prisma.webhookDelivery.count(...) > 0)` — the outbox reaper dispatches after commit.
  The delivery worker itself is off under test, so assert that the delivery row exists, not its outcome.
- **Background jobs**: call the job's exported function directly (`processDeliveryRetention()`,
  `processEntryRetention()`), then check the rows.

## Vitest Configuration

- Runner: Vitest; environment `node`; `globals: true` (suites still import from `"vitest"`)
- `testTimeout: 30000`, `hookTimeout: 60000`, `pool: "forks"`, `fileParallelism: false`
- `env: loadTestEnv()` for workers; `globalSetup` loads the same env itself

## DO

- Test through HTTP against the running server for anything a route does
- Get tokens from `getTestPrincipalToken` or the area's `getTestAccessToken` — never hand-craft one
- Test permission enforcement (403 with a narrower token), validation (400), missing auth (401),
  not-found (404, e.g. `NON_EXISTENT_UUID`), and cross-organization access (403 with an `other-org-*`
  token)
- Assert the audit entry (and webhook delivery where relevant) for new mutations
- Track what you create and remove it in `afterAll` (`cleanupTestEntities`); cleanup deletes through
  `prisma` because much of the API archives rather than deletes
- Add stragglers to the area's `cleanupAllTestEntities`, which `globalSetup` teardown calls
- Use unique names (`generateUniqueId()`) — the database persists across runs
- Use descriptive names: `it("returns 409 when the slug is taken by an archived organization")`

## DON'T

- Don't mock the database, Redis or auth — tests hit real Postgres, Redis and `requireAuth`
- Don't create permissions, roles or event types under core — use the test service
- Don't assume a clean database: migrations apply forward and the seed is idempotent, nothing is reset
- Don't point tests at the dev database or run them while the dev server holds port 4001
- Don't rely on another file's state — files run serially but in no promised order
- Don't forget `.js` on relative imports; sort imports longest-first like source files

## Additional Resources

- Complete examples (full suite file, area helpers, principals, setup files, vitest config):
  [examples.md](examples.md)
