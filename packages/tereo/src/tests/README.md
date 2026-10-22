# Server tests

`src/tests` mirrors `src/`. A source path tells you which test file covers it, and a test's path
tells you what it covers. `src/tests/conventions/testLayout.unit.test.ts` enforces every rule below
and lists the offending paths when one breaks. (`conventions/legacyPaths.ts` lists the files not yet
moved into this layout; it shrinks as they move.)

## Where files go

| Source                                         | Test                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| router folder `routes/v1/admin/users/user/`    | `routes/v1/admin/users/user/user.test.ts`                          |
| root router `routes/index.ts`                  | `routes/routes.test.ts` (e.g. `routes/routes.permissions.test.ts`) |
| module `utils/permissions.ts`                  | `utils/permissions.unit.test.ts`                                   |
| job `jobs/lifecycleSweep.ts`                   | `jobs/lifecycleSweep.test.ts`                                      |
| entry points `index.ts`, `app.ts`, `worker.ts` | `index.test.ts`, `app.test.ts`, `worker.test.ts`                   |
| behaviour spanning several routes              | `flows/<area>/<flow>.test.ts` (one folder per area, not nested)    |
| checks on the repo's own conventions           | `conventions/<name>.unit.test.ts`                                  |

Not tests: `setup/` (`globalSetup.ts`, `setup.ts`, `testEnv.ts`, `tags.ts`), `support/` (shared
helpers; `support/pure/` holds those with no database, server or Redis), `fixtures/` (static data and
child-process scripts).

A test that exercises one route belongs to that route even if it sets up state through others.
`flows/` is for tests whose subject is a sequence across routes.

## Filenames

```
<base>[.<aspect>][.<method>][.unit].test.ts
```

- `<base>`: the router folder's name or the source file's name, camelCase as in `src/`.
- `.unit`: pure; no database, server, Redis or network. Absent means `int`.
- `<aspect>`, from the list in `setup/tags.ts`:

  | Aspect        | Holds                                                                |
  | ------------- | -------------------------------------------------------------------- |
  | `validation`  | input and schema checks                                              |
  | `permissions` | route-specific authorization (org scope, ownership, hierarchy)       |
  | `races`       | concurrency and lock-order behaviour                                 |
  | `audit`       | audit entries, outbox events, webhook deliveries a mutation produces |
  | `limits`      | quotas, size caps, rate limits, pagination bounds                    |
  | `errors`      | error mapping and failure paths                                      |

- `<method>`: `get`, `post`, `put`, `patch` or `delete`; only as the last-resort split below.
- A file without an aspect holds the main behaviour. Add aspect files only when the main file would
  pass the cap, or when the aspect is a distinct tier (`.validation.unit`).

## Size cap

No `.ts` file under `src/tests` (test or support, `fixtures/` excepted) exceeds 500 lines. Split by
aspect; if one aspect still exceeds it, split by method (`user.validation.patch.unit.test.ts`). No
free-form names.

## Projects

| Project | Includes                | Setup                                                  | Files       |
| ------- | ----------------------- | ------------------------------------------------------ | ----------- |
| `unit`  | `**/*.unit.test.ts`     | none: no server, and an unreachable database and Redis | in parallel |
| `int`   | every other `*.test.ts` | `globalSetup`: migrates, seeds, starts one server      | serial      |

A `.unit` file must not import `utils/db/`, `utils/redis.ts`, `setup/` (except `tags.ts`) or
`support/` (except `support/pure/`). `int` tests use real users and tokens
(`getTestPrincipalToken`), test-made permissions and event types under the test service, and no
mocks of Postgres, Redis or auth.

## Tags

Declared in `setup/tags.ts`. File-level tags go at the top of the file, one per line (several on one
line silently drop all but the first):

```ts
// @module-tag int
// @module-tag files
```

| Tag             | Kind   | Description                                       |
| --------------- | ------ | ------------------------------------------------- |
| `unit`          | tier   | Runs with no database, Redis or server            |
| `int`           | tier   | Runs against the real server, Postgres and Redis  |
| `auth`          | area   | Sign-in, tokens, accounts, roles, OAuth           |
| `files`         | area   | File storage, sharing and blobs                   |
| `webhooks`      | area   | Webhook endpoints and deliveries                  |
| `notifications` | area   | Notifications and their delivery                  |
| `audit`         | area   | Audit log entries                                 |
| `provisioning`  | area   | Provisioning documents, services and the registry |
| `platform`      | area   | Health, setup, UI, startup and shutdown           |
| `race`          | detail | Concurrent requests or processes                  |
| `job`           | detail | Background jobs and schedulers                    |
| `security`      | detail | Security properties and attack paths              |
| `slow`          | detail | Takes long; raises the test timeout               |
| `redis-outage`  | detail | Behaviour while Redis is unavailable              |

Exactly one tier tag per file, matching `.unit`. At least one area tag, and the one the path
requires (`AREA_BY_PATH` in `tags.ts`, longest prefix wins). Detail tags are optional, at file,
`describe` or `it` level.

## What gets tested where

- **Validation**: table-driven `it.each` in `<base>.validation.unit.test.ts` against the route's
  exported Zod schemas. The route's `int` file keeps one case proving the schema is wired in and the
  400 has core's error shape.
- **Auth enforcement**: `routes/routes.permissions.test.ts` walks every mounted route and asserts
  401 without a token and 403 with a token without permissions. Per-route files test only
  route-specific authorization (`.permissions`).
- **Side effects**: one test per mutation for its audit entry, outbox event or delivery.
- **Business logic, database behaviour, races, sweeps, jobs**: `int`.
- **Duplicates**: the more expensive tier's copy goes. List each removal in the commit message as
  `removed: <old file> > <test name> -> covered by <new file> > <test name>`.

## Conventions inside a file

- The top-level `describe` names the route (`"PATCH /v1/admin/users/:id"`) or the exported function
  (`"processEntryRetention"`); `it` names state the behaviour (`"returns 409 when the slug is taken"`).
- Helpers come from `support/` (`http.ts`, `principals.ts`, `testService.ts`, `<area>.ts`).
- Unique names, cleanup in `afterAll`.

## Commands

```sh
npm run test:unit                                   # unit project; no Docker, DB or Redis needed
npm run test:int                                    # int project; postgres + redis up
npm run test:local -- --tags-filter "auth && race"  # any tag expression, both projects
npx vitest --list-tags
npm test                                            # docker/test/run.sh
```

## Where does my test go?

1. **A new admin route, `POST /v1/admin/widgets`.** The router folder is
   `routes/v1/admin/widgets/`; the test is `routes/v1/admin/widgets/widgets.test.ts`, tagged `int` and
   `auth`. Its audit entry goes in `widgets.audit.test.ts` if the main file nears the cap.
2. **A change to a Zod schema.** `routes/v1/admin/users/user/user.validation.unit.test.ts`, tagged
   `unit` and `auth`, with `it.each` against the exported schema. Keep one 400 case in `user.test.ts`.
3. **A job, `jobs/shareSweep.ts`.** `jobs/shareSweep.test.ts`, tagged `int`, `files` and `job`.
   Its area is not path-mapped, so pick the area the job serves.
4. **A race fix in role assignment.** `routes/v1/admin/roles/role/role.races.test.ts`, tagged `int`,
   `auth` and `race`. It stays with the route, not in a file named after the bug.
5. **A flow across routes, sign-in then refresh then revoke.** `flows/auth/tokenLifecycle.test.ts`,
   tagged `int` and `auth`. If one route is the subject, it belongs to that route instead.
