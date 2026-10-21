# tereo-e2e

End-to-end tests for Tereo: the admin UI (`tereo-ui`) driven in a real browser against a real core
(`tereo`), a real Postgres and a real Redis, with no API mocking. Written with
[Playwright Test](https://playwright.dev). Component behaviour belongs to `@kosmeo-ui/react`'s own
tests; these cover workflows.

## Running

Needs Docker's Postgres and Redis (`docker compose up -d postgres redis` from the repo root) and,
once, a browser:

```sh
npx playwright install chromium        # once per machine / Playwright version
npm run e2e                            # from the repo root: headless, skipping tests tagged @slow
npm run e2e:all                        # every test, @slow included
npm run e2e:ui                         # Playwright's UI mode, every test
npm run e2e:all -- src/tests/account   # one folder (any Playwright args pass through)
npm run e2e:report -w tereo-e2e        # open the last HTML report
```

`npm run e2e` passes `--grep-invert @slow`, so it skips `@slow` tests even when you name their
file. Use `e2e:all` for those. CI runs `e2e`, except on the release PR (`release/version-bump`),
which runs `e2e:all`.

Each run builds the UI, recreates the database, starts core on **:4501** and stops it afterwards
(about 40 s in all). It runs alongside a dev core (:4001) and UI (:4000).

While writing a spec, keep one core up and reuse it (its data then carries over between runs):

```sh
npm run e2e:core -w tereo-e2e                      # terminal 1: reset, build, run core
E2E_REUSE_CORE=1 npm run e2e -- src/tests/auth     # terminal 2
E2E_SKIP_UI_BUILD=1 npm run e2e:core -w tereo-e2e  # reset and restart without rebuilding the UI
```

## How the environment is isolated

`src/core/startCore.ts` is Playwright's `webServer`. On every run it:

1. builds the UI into `.e2e-state/ui-dist` (not `packages/tereo-ui/dist`), with `VITE_*` blanked so
   a developer's `.env` cannot point the build elsewhere;
2. **drops and recreates `core_e2e`** on the compose Postgres. It refuses any database whose name
   does not end in `_e2e`, so it can never touch `core` (dev) or `core_test` (the backend suite);
3. deletes the keys under its Redis prefix (`tereo-e2e:` in db **3**; dev uses 0, the suite 1) and
   its blob storage (`.e2e-state/storage`);
4. migrates and seeds, then starts core with a complete environment of its own (`src/core/coreEnv.ts`):
   a fixed `SETUP_TOKEN` and `UI_BASE_URL=http://localhost:4501`. It also points `DOTENV_CONFIG_PATH`
   at a file that never exists, so `packages/tereo/.env` is never read.

Nothing here runs `docker compose down` or removes volumes. Overrides: `E2E_PORT`, `E2E_DATABASE_URL`
(must end in `_e2e`), `E2E_REDIS_URL`, `E2E_REDIS_DB`, `E2E_REDIS_KEY_PREFIX`, `E2E_CORE_LOG_LEVEL`, and `E2E_STATE_DIR`
(default `.e2e-state`). Two runs can overlap when each has its own port, database, Redis prefix and
state directory, plus Playwright's `--output`.
Core's log goes to `.e2e-state/core.log`.

The **setup** project (`firstRun.setup.ts`) then completes first-run setup through the UI, signs in
as the admin it created, and saves the session to `.e2e-state/admin.json`. Every other spec starts
signed in as that admin and depends on it. That test is also the first-run workflow test.

## Layout

```
playwright.config.ts        projects (setup → chromium), webServer, reporters
src/config.ts               ports, URLs, database/Redis names, admin credentials
src/core/                   startCore.ts (the webServer) and coreEnv.ts
src/fixtures/               `test`/`expect` with `api` (CoreApi as the admin) and `uid`
src/utils/                  signIn (fresh contexts, PKCE sign-in), clientIp, totp, twoFactor,
                            clientCredentials (credentials dialogs, token grants, OAuth code exchange)
src/tests/
  firstRun.setup.ts         setup + admin sign-in
  auth/                     signed-out redirect, wrong password, sign-out, reload, revoked sessions;
                            recovery-code sign-in and regeneration; 2FA required by a role;
                            consent for a third-party client (approve, deny)
  auth-admin/               users (create, roles, deactivate, reset 2FA); roles (create, edit,
                            duplicate, deactivate/archive/restore, delete, remove a holder);
                            permissions (nav and URLs follow the role, live updates);
                            OAuth clients (secret once, edit, regenerate, delete)
  organizations/            create/edit, members and tiers, org roles, archive/restore; org-select
                            at sign-in and switching organization
  file-storage/             buckets, upload/browse/search, versions, delete/restore, shares,
                            per-user bucket grants
  webhooks/                 endpoints, deliveries, event types
  services/, integrations/  credentials once, rename, secret rotation and overlap, deactivate;
                            integration roles and audiences
  audit-log/                entries and detail, sign-in with client address
  account/                  2FA (TOTP) enrolment, recovery codes shown, sign-in, turning it off;
                            password change, sessions, profile photo, account details
  api-docs/                 Redoc renders core's spec
```

## Adding a test

- Import `test` and `expect` from `src/fixtures/index.js`, not from `@playwright/test`.
- **Tag a slow test `@slow`** (`test("…", { tag: "@slow" }, async (…) => …)`): one that waits out a
  30-second TOTP step, or takes several full sign-ins. CI skips these everywhere but the release
  PR. Keep the fast test of each workflow untagged, so every PR still covers it.
- **Make it independent.** Name everything with `uid("prefix")`; never rely on another spec's data
  or order. Specs run in parallel against one core.
- **Seed through the API** (`api.createUser`, `createRole`, `setRolePermissions`, `setUserRoles`,
  `createOrganization`, `addOrganizationMember`, `createBucket`, `uploadObject`,
  `createWebhookEndpoint`, the `create*` helpers in `utils/clientCredentials.ts`, or `api.request`
  for anything else) when the data is not what the test is
  about; drive the UI for what it is about.
- **Never sign the shared admin out**, revoke its sessions or change its roles. A test that needs
  that signs in a user of its own: `signedInPage(browser, email, TEST_PASSWORD)`, or
  `signedOutPage(browser)` for a visitor. A context from `browser.newContext()` inside a test
  inherits the admin's storage state, so use these helpers.
- **Locators:** `getByRole` / `getByLabel` / `getByText`; no CSS selectors or fixed waits. kosmeo
  puts the required-field `*` inside `<label>`, so use `getByRole("textbox", { name, exact: true })`
  where `getByLabel(…, { exact: true })` would miss. Its modals are named by their title, so
  `page.getByRole("dialog", { name: "Create Webhook Endpoint" })` finds one; an unnamed
  `page.getByRole("dialog")` also works, as one is open at a time.
- Each browser context gets its own `X-Forwarded-For` address (`utils/clientIp.ts`). Core limits
  failed sign-ins per client and IP, and a few specs fail one on purpose.
- A test that uncovers an app bug stays, as `test.fixme` with a comment describing the bug.

## Known issues the suite records

- A wrong password on a share's unlock page only clears the field, with no message (asserted as is).

## CI

The `e2e` job in `.github/workflows/ci.yml` runs beside the `ci` job, not inside `test:docker`:
this package has no `test`/`test:docker` target, so `nx affected -t test:docker` skips it. Its
`check` target joins the type-check job.

- It runs when `nx show projects --affected` includes `tereo-e2e`, which declares `tereo` and
  `tereo-ui` as implicit dependencies, and always on a `workflow_dispatch` run. Otherwise its
  steps skip and the job passes.
- Services: `postgres:18-alpine` (user/password `core`) on 5442 and `redis:7-alpine` on 6389, as in
  `docker-compose.yml`, so the config's defaults apply.
- Chromium is cached on the Playwright version; its system libraries are installed every run.
- Actions sets `CI`, so the run takes 1 retry and 2 workers, fails on `.only`, and annotates
  failures through the GitHub reporter.
- Every run takes `npm run e2e`, which skips tests tagged `@slow`, except on the release PR's
  branch, `release/version-bump`, which takes `npm run e2e:all`, so every test still runs before a
  release. `create-version-pr.yml` starts that branch's CI as a `workflow_dispatch` run, so the job
  matches `github.ref_name` as well as a PR's `github.head_ref`.
- On failure it uploads `e2e-report`: `playwright-report/`, `test-results/` (traces, videos) and
  `.e2e-state/core.log`.
- Sharding (`--shard=i/n`) works, with one service set per shard job, since each shard recreates
  its own database. On 2 workers, `e2e` takes about 2.5 minutes and `e2e:all` about 3, so one job is
  enough for now; shard it if that grows.

## Not a release package

`tereo-e2e` is private and in no Nx release group (`nx.json` lists `tereo`, `tereo-ui` and
`@tereo-io/sdk`), so changes to it need no version plan.

## Troubleshooting

- `http://localhost:4501/health is already used`: an e2e core is still up (`npm run e2e:core`).
  Stop it, or set `E2E_REUSE_CORE=1`.
- Timeouts far longer than the configured ones, or a core that starts and never listens: the
  machine slept mid-run. Run it under `caffeinate -i` on macOS.
- `Too many failed authentication attempts`: a context without its own address, so make it with
  `signedOutPage`.
