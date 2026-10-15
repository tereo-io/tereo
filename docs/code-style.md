# Code Style

CI enforces these rules and fails on any of them:

```sh
npm run format:check        # Prettier          (npm run format to fix)
npm run sort-imports:check  # import order      (npm run sort-imports to fix)
npm run lint                # ESLint
npx nx run-many -t check    # tsc --noEmit
```

## Formatting

Enforced by Prettier. Key settings:

- **Indent**: 2 spaces
- **Semicolons**: always
- **Quotes**: double
- **Trailing commas**: ES5 (objects, arrays, multi-line function params)
- **Print width**: 80 (soft limit)

## TypeScript

- **Strict mode**: enabled on all packages
- **No `any`**: use `unknown` or proper types; if unavoidable, add a comment explaining why
- **Runtime validation**: always Zod for data crossing a boundary (request bodies, query params, env vars)
- **ES modules**: `.js` extensions on all relative imports in backend packages, directory imports included (`./oauth/index.js`)
- **Type imports**: `import type { ... }` for type-only imports

## Naming

| Thing | Convention | Example |
|-------|-----------|---------|
| Variables / functions | camelCase | `getUserById`, `isActive` |
| Classes / interfaces / types | PascalCase | `RegistryClient`, `AuditLogEntry` |
| React components | PascalCase | `BucketList`, `CreateServiceButton` |
| Files (backend) | camelCase | `coreRegistration.ts`, `bucketAccess.ts` |
| Files (frontend) | PascalCase for components, camelCase for hooks | `BucketList.tsx`, `useCreateBucket.ts` |
| Database fields | camelCase (Prisma maps to snake_case in the DB) | `createdAt`, `organizationId` |
| Environment variables | SCREAMING_SNAKE_CASE | `REDIS_URL`, `CORE_CLIENT_ID` |
| CSS classes (`@kosmeo-ui/react`) | `v-` prefix + kebab-case | `v-button`, `v-modal-content` |

## Error Handling

- Use the error classes from core's `utils/errors.ts` — never `res.status(400).json(...)` directly
- Never swallow errors silently; log them with `logger.error` if you can't rethrow
- Log the error itself under `err` (`logger.error({ err }, "msg")`), which Pino serializes with its
  stack — not its message, and not under `error`. ESLint (`no-restricted-syntax`) refuses both
- Best-effort calls (an SDK's `audit.log`, `webhooks.emit`) catch and log, never propagate; anything
  that must happen goes through the outbox in the caller's transaction

```typescript
// Good
throw new NotFoundError("Bucket not found");
throw new ForbiddenError("Write permission required");

// Bad
res.status(404).json({ message: "Not found" });
```

## Comments

Add comments only where the logic isn't self-evident. Don't comment what code does — comment why it
does it. The `comments` skill has the full rules.

```typescript
// Good — explains non-obvious reasoning
// Redis key includes organizationId to prevent cross-tenant cache poisoning
const cacheKey = `introspect:${organizationId}:${token}`;

// Bad — restates the code
// Set the status to active
user.status = "active";
```

## Environment Variables

Core has one env schema, `packages/tereo/src/env.ts`, validated with Zod at startup; the
service fails to start with a clear error when a required variable is missing. `src/preload.ts`
(which loads `.env`) must be the first import of every entry point.

## Frontend CSS

- CSS classes inside `@kosmeo-ui/react` use the `v-` prefix: `v-button`, `v-input`, `v-modal`.
- Use CSS custom properties (`--primary-color`, `--text-size-sm`) for theming — no `v-` prefix on
  custom properties.
- **No inline `style={{}}`** — every component gets a class and a rule in its `styles.css`. Acceptable
  inline cases: feeding a user-supplied color into a CSS custom property the rule reads,
  runtime-computed measurements, library escape hatches.
- **No hardcoded colors** — every color comes from a CSS variable defined in
  `@kosmeo-ui/react`'s `styles.css`. When no token fits, add one there (under both `:root` and
  `[data-theme="dark"]`).
- Prefer existing `@kosmeo-ui/react` primitives over hand-rolled markup. Extend a component
  before forking it.

## Import Ordering

Imports are sorted by **line length, longest first**. Single-line imports come before multi-line
imports, which are ordered by the length of their last line.

```typescript
// packages/tereo/src/routes/v1/account/index.ts
import { rateLimitGeneral } from "../../middleware/rateLimit.js";
import { requireAuth } from "../../middleware/auth.js";
import photoRouter from "./photo/index.js";
import totpRouter from "./totp/index.js";
import { Router } from "express";
import {
  getProfile,
  getSessions,
  revokeSession,
  revokeAllSessions,
  changePassword,
} from "./controllers.js";
```

Two exceptions keep code working: side-effect imports that come before every other import
(`import "./preload.js"`) stay first, in order, and a comment above the first import stays on top.

```sh
npm run sort-imports                                  # every package's src/
npx tsx scripts/sort-imports.ts <file-or-dir>...      # specific paths
```

To sort on save in VS Code, install *Run on Save* (`emeraldwalk.runonsave`) and add to your
(gitignored) `.vscode/settings.json`:

```json
{
  "emeraldwalk.runonsave": {
    "commands": [
      {
        "match": "\\.(ts|tsx)$",
        "cmd": "npx tsx ${workspaceFolder}/scripts/sort-imports.ts ${file}",
        "isAsync": true,
        "silent": true
      }
    ]
  }
}
```

## Releases

Every package is versioned with Nx release version plans, in two release groups:

- `sdk`: `@tereo-io/sdk`, published to npm and tagged `@tereo-io/sdk@<version>`.
- `core`: `tereo` and `tereo-ui`, which share one version because they ship as one image. It is
  tagged `tereo@<version>`, and neither package is published to npm.

A PR that changes a package needs a plan for its group: `npm run version-plan`, then commit the file
in `.nx/version-plans/`. When the PR merges, CI opens a `chore(release): bump versions` PR.

Before 1.0, a plan's bump is one step smaller than its name: `major` for a breaking change gives
0.1 → 0.2, `minor` for a feature and `patch` for a fix both give 0.1.0 → 0.1.1. Plan a breaking
change as `major`.

Merging that PR runs `publish.yml`, which releases each group whose version has no tag yet: the SDK
to npm, and core's image to `ghcr.io/tereo-io/tereo` as `<version>`, `<major>.<minor>` and `latest`
(amd64 and arm64), with the Helm chart in `charts/tereo` at the same version to
`oci://ghcr.io/tereo-io/charts/tereo`. It then pushes the tag. Run it by hand (`workflow_dispatch`) for the first release
or to retry one that failed.
