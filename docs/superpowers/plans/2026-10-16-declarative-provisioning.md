# Declarative Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace service registration with a JSON provisioning folder that declares every app
service (with its permissions, roles, buckets, event types, access and webhook subscriptions),
login clients and custom roles, applied at start and by a CLI command.

**Architecture:** `utils/provisioning/` grows from one YAML file to a set of JSON documents:
`load.ts` reads and parses them, a new `validate.ts` checks the set as a whole (cross-document
references, uniqueness, secrets), and `apply.ts` writes it in one transaction, reusing the
registry's `apply*` functions for declarations. Registration (`POST /v1/registry/declaration`, the
SDK's `register()`, access requests and their approval machinery) is deleted. Core's own
declaration keeps being applied in-process by `registerCore()`.

**Tech Stack:** TypeScript (ESM), Express, Prisma/Postgres, Zod 4 (`z.toJSONSchema`), Vitest,
Helm, React (tereo-ui, `@kosmeo-ui/react`).

**Spec:** `docs/superpowers/specs/2026-10-16-declarative-provisioning-design.md`

## Global Constraints

- JSON only. Directory mode reads `*.json` directly inside the folder, in name order, skipping names starting with `.`; other extensions and subdirectories are ignored.
- `PROVISIONING_PATH` replaces `PROVISIONING_FILE` (file or directory). Unset: nothing applied or retired.
- Every document: required semver `version`, optional `$schema` (ignored), at least one of `service` (at most one), `clients`, `roles`. Unknown keys refused at every level.
- All-or-nothing: every problem is reported, each prefixed with its file name; any problem means nothing is written.
- Provisioning is applied only at start and by `npm run cli -- provision`. No HTTP route applies it.
- Core's declaration stays in code (`CORE_DECLARATION`, `registerCore()`).
- A lower `version` than stored is applied, with a warning log naming both versions.
- Access listed in the file follows the role; access removed from the file is revoked at that apply; an admin-revoked row stays revoked while the file lists it.
- Webhook entries of the same service may share a secret; across services they may not.
- Provisioned rows are read-only through the admin API: `409` with code `managed_by_provisioning`.
- Webhooks a service drops are archived at once; services, clients and custom roles get `REGISTRY_RETIREMENT_GRACE_HOURS`.
- Every write is audited as `SYSTEM_USER_ID`, with the document's `file` and `version` in metadata.
- Style: `npm run format && npm run sort-imports && npm run lint` before each commit; `.js` extensions on relative imports; errors from `utils/errors.ts`; raw SQL names tables with their schema.
- Never use `git stash` (shared refs across worktrees).

## Review Focus

- A ConfigMap mount: `..data` symlink directory and `..2026_…` timestamp dirs inside the folder must be skipped, and files reached through the `..data` symlinks still read — test in Task 1.
- An empty directory, or one with no `*.json`: means "nothing provisioned" and so retires every provisioned row after the grace — a likely accident. Treat it as a problem (`no provisioning documents in <path>`) — test in Task 1.
- Two replicas starting while the CLI Job runs: one applies, the others find nothing to do — test in Task 4 (`applies once when two applies race`).
- A service file renamed (same slug, different file name): must be an update, not remove-and-create — test in Task 4.
- Rollback of a single service document to a lower version that drops a permission another document's custom role uses: must fail validation, not apply and break the role — test in Task 2.

---

### Task 1: Document schema and JSON loader

**Files:**
- Modify: `packages/tereo/src/utils/provisioning/schema.ts` (rewrite)
- Modify: `packages/tereo/src/utils/provisioning/load.ts` (rewrite the reading/parsing half)
- Modify: `packages/tereo/src/env.ts:293` (`PROVISIONING_FILE` → `PROVISIONING_PATH`)
- Modify: `packages/tereo/package.json` (drop `yaml` if nothing else imports it — check with `grep -rn "from \"yaml\"" src`)
- Test: `packages/tereo/src/tests/unit/provisioningLoad.test.ts` (rewrite)

**Interfaces:**
- Produces (in `schema.ts`):
  - `ProvisioningDocumentSchema` (Zod, `.strict()` everywhere): `{ $schema?: string; version: semver string; service?: ServiceEntry; clients?: ClientEntry[]; roles?: CustomRoleEntry[] }`, refined to need one of the three sections.
  - `ServiceEntry`: today's service fields (`slug`, `name`, `namespace?`, `clientId?`, `secretFrom`, `access{roles,audiences}`) plus `declarationSchema`'s `permissions`, `systemRoles`, `buckets`, `eventTypes` (import the item schemas from `utils/registry.ts`; export them there as `permissionItem`, `systemRoleItem`, `bucketItem`, `eventTypeItem`) plus `webhooks: WebhookEntry[]` (default `[]`).
  - `WebhookEntry`: `{ key: Slug; url: string (max 2048); events: string[] (min 1); secretFrom: EnvName; organizations: "all" | uuid[] (default "all", array min 1); description?: string (max 500) }`.
  - `ClientEntry`: today's, plus `description?: string (max 500)`.
  - `CustomRoleEntry`: `{ name: /^[a-z][a-z0-9_-]*$/ max 100; displayName: max 255; description?: max 500; orgAssignable: boolean default false; permissions: string[] }`.
  - `export type ProvisioningDocument = z.input<typeof ProvisioningDocumentSchema>` (what authors write).
- Produces (in `load.ts`):
  - `interface LoadedDocument { file: string; version: string; service: ResolvedService | null; clients: ResolvedClient[]; roles: CustomRoleEntry[] }`
  - `ResolvedService`: the parsed `ServiceEntry` with defaults applied (`namespace`, `clientId`), `secretEnv`, `secretHash`, and `webhooks: ResolvedWebhook[]` where `ResolvedWebhook` adds `secretEnv` and `secretPlain` (webhook secrets are sealed, not hashed, so the plaintext is kept in memory only).
  - `ResolvedClient`: today's `ProvisionedClientSpec` plus `description`.
  - `interface ProvisioningSet { documents: LoadedDocument[] }`
  - `readProvisioningPath(path: string): Promise<{ file: string; text: string }[]>` — directory or file per Global Constraints; a path that cannot be read, or a directory with no `*.json`, is a `ProvisioningError`.
  - `parseDocuments(files: { file: string; text: string }[], env: NodeJS.ProcessEnv): ProvisioningSet` — strict `JSON.parse`, schema, secret resolution (`resolveSecrets`, kept); every problem prefixed `<file>: `; throws one `ProvisioningError` with all problems.
  - `loadProvisioning(path: string | undefined, env?): Promise<ProvisioningSet | null>` (null when unset).
  - `ProvisioningError` unchanged.

- [ ] **Step 1: Write the failing tests** in `provisioningLoad.test.ts`. Keep the env/secret helpers at the top of the current file; replace the rest. Tests (names and the assertions that matter):
  - `reads every *.json in a directory in name order` — temp dir with `b.json`, `a.json`, `notes.txt`, `.hidden.json`, a subdir `sub/c.json`; `set.documents.map(d => d.file)` equals `["a.json", "b.json"]`.
  - `reads through a ConfigMap-style mount` — create `..2026_10_16/a.json`, symlink `..data -> ..2026_10_16`, symlink `a.json -> ..data/a.json`; documents `["a.json"]`.
  - `reads a single file` — path to one file; one document.
  - `refuses a directory with no documents` — problems `["no provisioning documents in <dir>"]`.
  - `reports JSON syntax errors with the file name` — `{"version": "1.0.0",}` → one problem starting `bad.json: not valid JSON`.
  - `refuses a document with no section` — `{"version":"1.0.0"}` → problem contains `needs one of service, clients, roles`.
  - `refuses a non-semver version` — `"1.10"` → problem names `version`.
  - `refuses unknown keys at every level` — unknown top-level, service, webhook and role key: four problems, each naming the key, none echoing values.
  - `applies service defaults` — `namespace` and `clientId` from slug, `webhooks` `[]`, `organizations` `"all"`.
  - `resolves service, client and webhook secrets` — `secretHash` equals `hashFlowToken(SECRET_A)`; webhook `secretPlain` equals the env value.
  - `lets webhooks of one service share a secret` — two webhooks, one `secretFrom`: no problem.
  - `refuses a secret shared across services, or between a service and a webhook` — problem contains `used by more than one entry`.
  - `never includes a secret in problems` (keep the existing test, adapted).
  - `returns null when PROVISIONING_PATH is unset`.

- [ ] **Step 2: Run them to see them fail**
  Run: `cd packages/tereo && npx vitest run src/tests/unit/provisioningLoad.test.ts`
  Expected: FAIL (exports `readProvisioningPath` / `parseDocuments` missing).

- [ ] **Step 3: Implement the schema and loader.** Rename the env var in `env.ts` (`PROVISIONING_PATH: z.string().optional()`) and its use in `provisioning/index.ts`. Cross-document checks (duplicates, references, requestable roles) move to Task 2: remove them from `load.ts`, keeping only per-entry rules (confidential/public secret, redirect URI safety, authorization_code needs a redirect URI). Secret-sharing rule: duplicates are allowed only among `webhooks` of the same service entry.

- [ ] **Step 4: Run the tests to see them pass** (same command). Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add packages/tereo/src/utils/provisioning packages/tereo/src/env.ts packages/tereo/src/tests/unit/provisioningLoad.test.ts packages/tereo/package.json package-lock.json
  git commit -m "feat(core): load provisioning from a folder of JSON documents"
  ```

---

### Task 2: Validate the set as a whole

**Files:**
- Create: `packages/tereo/src/utils/provisioning/validate.ts`
- Modify: `packages/tereo/src/utils/registry.ts` (export `declarationProblems` and make `assertRolesPrefixed` a problem-returning `rolePrefixProblems`)
- Test: `packages/tereo/src/tests/unit/provisioningValidate.test.ts`

**Interfaces:**
- Consumes: `ProvisioningSet`, `LoadedDocument` (Task 1); `PERMISSION_CATALOG`, `ROLES`, `isRequestableCoreRole`, `CORE_DECLARATION`, `RESERVED_EVENT_TYPES`, `READ_PERMISSIONS` (`definitions/`); `hasPermission` (`utils/permissions.ts`); org-assignable flags from `definitions/permissions.ts`.
- Produces:
  - `validateSet(set: ProvisioningSet): string[]` — pure (no database), every problem prefixed with the file(s) concerned.
  - `registry.ts`: `export const declarationProblems(service: RegistryService, d: ParsedDeclaration): string[]` and `export const rolePrefixProblems(service: RegistryService, d: ParsedDeclaration): string[]` (`registerDeclaration` keeps throwing on them, so core's path is unchanged).
  - `permissionsOfAccess(set: ProvisioningSet, service: ResolvedService): string[]` — what the service's account will hold: permissions of each requestable core role (from `ROLES`) and of each `<slug>/<name>` system role in the set. Used by the webhook rule and by Task 5.

- [ ] **Step 1: Write the failing tests.** Build sets in memory (helper `doc(file, body)` producing a `LoadedDocument`). Tests:
  - `accepts a mutual pair granting each other roles` — `a.json` service `alpha` with role `alpha_reader`, access `beta-service/beta_reader`; `b.json` the reverse → `[]`.
  - `refuses a role naming no service in the set` — `access.roles: ["ghost-service/x"]` → `a.json: services[alpha-service]: access.roles "ghost-service/x" is not a system role declared in the provisioning set`.
  - `refuses its own role, core/ spellings and non-requestable core roles` — `alpha-service/alpha_reader`, `core/file_user`, `admin` → three problems.
  - `refuses an audience naming no service in the set`, for both a service and a login client.
  - `reports duplicates naming both files` — same slug in `a.json` and `b.json` → problem contains `a.json` and `b.json`; likewise namespace, clientId (service vs login client), custom role name, permission name, event type, bucket name, webhook key within one service.
  - `refuses a custom role permission nobody declares`, and accepts one that is core's or another document's.
  - `refuses an org-assignable custom role with a global-only permission` (e.g. `users.read`).
  - `refuses a custom role named like a system role` (core's `admin`, or a service's `alpha_reader`).
  - `refuses a rollback that drops a permission a custom role uses` — `roles.json` uses `alpha.items.write`, `alpha.json` (version `1.0.0`) no longer declares it → problem names both.
  - `refuses a webhook event no service declares, and the reserved webhook.test`.
  - `refuses a webhook its owner could not read` — event `beta.item.created` with `readPermission` `beta.items.read`, owner `alpha` without access to a role granting it → problem `webhooks[k]: alpha-service could not read beta.item.created (needs beta.items.read); add a role granting it to access.roles`. With `access.roles: ["beta-service/beta_reader"]` → `[]`. A core event (`auth.organization.created`) needs the permission `READ_PERMISSIONS` gives it, through a requestable core role.
  - `passes declaration rules through, prefixed with the file` — a permission outside the namespace → `a.json: services[alpha-service]: …`.

- [ ] **Step 2: Run them to see them fail**
  Run: `cd packages/tereo && npx vitest run src/tests/unit/provisioningValidate.test.ts`
  Expected: FAIL (module missing).

- [ ] **Step 3: Implement `validate.ts`** and the two exports in `registry.ts`. A service's declaration is checked with `declarationProblems`/`rolePrefixProblems` using a `RegistryService` built from the entry (`{ id: "", slug, namespace }`; check the functions need nothing else). Permission matching uses `hasPermission` (hierarchy).

- [ ] **Step 4: Run the tests to see them pass**, plus the registry suite to confirm core's path is untouched:
  Run: `npx vitest run src/tests/unit/provisioningValidate.test.ts src/tests/registry/registry.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit** — `feat(core): validate a provisioning set across documents`.

---

### Task 3: Migration

**Files:**
- Modify: `packages/tereo/prisma/schema.prisma`
- Create: `packages/tereo/prisma/migrations/<timestamp>_declarative_provisioning/migration.sql` (via `npx prisma migrate dev --create-only --name declarative_provisioning`)

**Interfaces:**
- Produces (Prisma fields later tasks use):
  - `Role.provisioned Boolean @default(false)`, `Role.unprovisionedAt DateTime? @map("unprovisioned_at")`.
  - `WebhookEndpoint.organizationId String?`; `ownerServiceId String? @map("owner_service_id") @db.Uuid` with relation `ownerService Service?` (`onDelete: Restrict`); `provisioned Boolean @default(false)`; `provisioningKey String? @unique @map("provisioning_key") @db.VarChar(300)`.
  - `Service.provisionedAccess` removed.

- [ ] **Step 1: Edit the schema and generate the migration.** Append raw SQL Prisma cannot express:
  ```sql
  ALTER TABLE "webhooks"."webhook_endpoints"
    ADD CONSTRAINT "webhook_endpoints_org_or_owner"
    CHECK ("organization_id" IS NOT NULL OR "owner_service_id" IS NOT NULL);
  DELETE FROM "auth"."service_access" WHERE "status" = 'pending' AND "decided_at" IS NULL;
  ```
  Keep the rest of `service_access` (approved/revoked rows stay the record of access). Check the generated SQL for a PK-reset statement on partitioned tables and delete only that, per CLAUDE.md.

- [ ] **Step 2: Apply and regenerate.**
  Run: `cd packages/tereo && npx prisma migrate deploy && npx prisma generate && npx tsc --noEmit`
  Expected: migration applies; `tsc` errors only where code reads `provisionedAccess` or assumes `organizationId: string` on endpoints. Fix them minimally: replace `provisionedAccess` reads with `{ roles: [], audiences: [] }` (Task 4 rewrites those paths); where an endpoint was loaded by a query that filters on `organizationId`, its value is known non-null, so assert it (`endpoint.organizationId!`). Task 6 handles null organizations properly.

- [ ] **Step 3: Run the webhooks and registry suites**
  Run: `npx vitest run src/tests/webhooks src/tests/registry`
  Expected: PASS.

- [ ] **Step 4: Commit** — `feat(core): schema for provisioned roles and service-owned webhook endpoints`.

---

### Task 4: Apply services, declarations and access

**Files:**
- Modify: `packages/tereo/src/utils/provisioning/apply.ts`
- Modify: `packages/tereo/src/utils/provisioning/index.ts`
- Modify: `packages/tereo/src/utils/registry.ts` (extract `applyDeclarationTx`)
- Modify: `packages/tereo/src/utils/serviceAccess.ts` (add `syncProvisionedAccessTx`; request approval removed in Task 7)
- Modify: `packages/tereo/src/utils/services.ts` (`createServiceTx` no longer takes `provisionedAccess`)
- Test: `packages/tereo/src/tests/provisioning/provisioning.test.ts` (rewrite the helpers and the `applyProvisioning` and `pre-approved access` blocks; `describe("access")` replaces the latter)

**Interfaces:**
- Consumes: `ProvisioningSet`, `validateSet`, `permissionsOfAccess` (Tasks 1–2); Prisma fields (Task 3).
- Produces:
  - `registry.ts`: `applyDeclarationTx(tx: Tx, service: RegistryService, declaration: ParsedDeclaration, actor: { userId: string; email: string | null }, now: Date, meta?: { file?: string }): Promise<{ changed: boolean; summary: ApplySummaryByKind }>` — the body of `registerDeclaration`'s transaction from `applyPermissions` to the `core.service.declared` event, without `applyRequestedAccess`/`reopenGrownAccess`; skips when hash and version match; logs a warning `Applied a declaration older than the one applied before` with both versions when lower. `registerDeclaration` (core only now) wraps it in its transaction and keeps refusing older versions for core.
  - `serviceAccess.ts`: `syncProvisionedAccessTx(tx: Tx, service: AppService, wanted: { roles: string[]; audiences: string[] }, now: Date): Promise<{ granted: string[]; extended: string[]; revoked: string[] }>` — creates missing rows as `approved` (system user), updates `approvedPermissionIds` of approved role rows to the role's current permissions (follows the role), revokes approved rows no longer wanted (removes the `userRole`, removes the audience from the client), leaves `revoked` rows alone; audits and emits `core.service.access-approved`/`-revoked` through `decideAccessTx`.
  - `applyProvisioning(set: ProvisioningSet, now?: Date): Promise<ProvisioningResult>` — `ProvisioningResult` gains `declared: string[]` and `access: string[]`.

- [ ] **Step 1: Rewrite the test helpers** for documents: `serviceDoc(extra)` returning `{ file, version, service }` with a unique `prov-…` slug and a resolved secret; `setOf(...docs)`; `apply(...docs)` calling `applyProvisioning(setOf(...))`. Keep `serviceRow`, `holdsRole`, `accessRow`, `removeServices` (extend `removeServices` to remove provisioned custom roles and owned endpoints of the services).

- [ ] **Step 2: Write the failing tests:**
  - Port every existing `applyProvisioning` test (create, idempotent, update, rotate, secret reuse, rollback message, unprovisioned row refused, missing marked, retirement, race, managed 409, revoke-previous-secret, audit as system user) to documents.
  - `applies a service's declaration with the document's version` — the service's permission and role exist; `declarationVersion` `"1.4.0"`; audit metadata has `file` and `version`.
  - `skips an unchanged declaration` — second apply: no new audit entry for the service.
  - `applies a lower version, with a warning` — version `1.0.0` after `1.1.0`: applied (`declarationVersion` `1.0.0`).
  - `treats a renamed file as the same service` — same slug, file `x.json` then `y.json`: `result.created` empty the second time.
  - `grants a mutual pair each other's roles in one apply` — both `holdsRole` true, rows `approved`, `decidedBy` system user.
  - `extends approved access when the role grows` — owner adds a permission to its role and reapplies: consumer's account holds it, `approvedPermissionIds` length 2, no `core.service.access-requested` outbox row.
  - `revokes access removed from the file` — reapply without the role: row `revoked`, `holdsRole` false.
  - `keeps an admin's revocation while the file lists it` — admin revokes via `POST …/access/revoke`; reapply: still `revoked`.
  - `refuses the whole set when one document is invalid` — two documents, one bad: `ProvisioningError`, and the good document's service does not exist.
  - `applies once when two applies race` (keep the existing race test, adapted).

- [ ] **Step 3: Run them to see them fail**
  Run: `cd packages/tereo && npx vitest run src/tests/provisioning/provisioning.test.ts`
  Expected: FAIL.

- [ ] **Step 4: Implement.** In `applyProvisioning`: run `validateSet` first (throw on problems), then inside the locked transaction: `findProblems` (database checks, as today, over every document's service and clients), services, declarations (`applyDeclarationTx` per service), access (`syncProvisionedAccessTx` per service, after every declaration so cross-service roles exist), clients, `markMissing`. Remove the post-commit `approveProvisionedAccess` loop. Raise the transaction timeout to 120 s. `provision()` in `index.ts` logs per-document counts.

- [ ] **Step 5: Run the provisioning and registry suites**
  Run: `npx vitest run src/tests/provisioning src/tests/registry`
  Expected: PASS (registry tests that exercise registration still pass until Task 7 removes them).

- [ ] **Step 6: Commit** — `feat(core): apply service declarations and access from provisioning`.

---

### Task 5: Custom roles

**Files:**
- Modify: `packages/tereo/src/utils/provisioning/apply.ts` (`applyRoles`, removals, `deprovisionMissing`)
- Modify: `packages/tereo/src/routes/v1/admin/roles/role/controllers.ts` (409 on provisioned roles)
- Test: `packages/tereo/src/tests/provisioning/provisioning.test.ts` (`describe("custom roles")`)

**Interfaces:**
- Consumes: `CustomRoleEntry` (Task 1); `Role.provisioned`, `Role.unprovisionedAt` (Task 3).
- Produces: `ProvisioningResult.roles: string[]`; `deprovisionMissing` returns `{ services, clients, roles }`.

- [ ] **Step 1: Write the failing tests:**
  - `creates a custom role over core and service permissions` — role exists with `serviceId` null, `provisioned` true, both permissions.
  - `replaces a custom role's permissions` on reapply, audited once.
  - `refuses a custom role whose name a hand-made role holds` — problem contains `was not created from the provisioning file`.
  - `refuses admin edits with 409 managed_by_provisioning` — `PATCH`, `DELETE`, archive and permission changes on `/v1/admin/roles/:id`; assigning it to a user still `200`/`201`.
  - `archives a role missing from the set after the grace`, and `restores it when it returns`.

- [ ] **Step 2: Run to see them fail** — `npx vitest run src/tests/provisioning/provisioning.test.ts -t "custom roles"`; Expected: FAIL.

- [ ] **Step 3: Implement.** Use the existing custom-role write path (`db.roles`) where one exists so caches and `core` events stay consistent; mark `provisioned`. The 409 uses the error class the services/clients routes use for `managed_by_provisioning` (find it with `grep -rn managed_by_provisioning src/utils`).

- [ ] **Step 4: Run to see them pass**, plus `npx vitest run src/tests/auth` (roles admin). Expected: PASS.

- [ ] **Step 5: Commit** — `feat(core): custom roles from provisioning`.

---

### Task 6: Service-owned webhook endpoints

**Files:**
- Modify: `packages/tereo/src/utils/provisioning/apply.ts` (`applyWebhooks`)
- Modify: `packages/tereo/src/utils/webhookSecrets.ts` (seal a given plaintext — `newEndpointSecret(id, plaintext)` already takes one)
- Modify: `packages/tereo/src/utils/db/webhookEndpoints.ts` (`findActiveByOrgAndEvent`)
- Modify: `packages/tereo/src/utils/webhookAccess.ts` (`createRecipientCheck`)
- Modify: `packages/tereo/src/utils/processEvent.ts` and the emit path that call the two above
- Modify: `packages/tereo/src/routes/v1/webhooks/webhooks/**` (409 on provisioned endpoints; owned all-organization endpoints visible to `webhooks.admin`)
- Test: `packages/tereo/src/tests/provisioning/provisioning.test.ts` (`describe("webhooks")`), `packages/tereo/src/tests/webhooks/ownedEndpoints.test.ts` (create)

**Interfaces:**
- Consumes: `ResolvedWebhook` (Task 1); endpoint fields (Task 3); the service's account user from Task 4.
- Produces:
  - `provisioningKey` format: `<service slug>:<key>` for `"all"`, `<service slug>:<key>:<organization id>` per listed organization.
  - `findActiveByOrgAndEvent(organizationId, eventType)` also returns `ACTIVE`, unarchived endpoints with `organizationId: null` and an owner.
  - `createRecipientCheck(event, readPermission)` returns `(endpoint: { createdBy: string; ownerServiceId: string | null }) => Promise<boolean>`; for an owned endpoint the `webhooks.read` requirement is skipped, `readPermission` and the bucket rule still apply to the owner's account (`createdBy`). Cache key stays `createdBy` plus owned-ness.

- [ ] **Step 1: Write the failing tests:**
  - Provisioning: `creates an owned endpoint for every organization` — row with `organizationId` null, `ownerServiceId` the service, `createdBy` its account user, `provisioned` true, subscriptions as listed; secret opens to the env value.
  - `creates one endpoint per listed organization`.
  - `updates url, events and description in place on reapply`, keyed by `provisioningKey`.
  - `rotates the secret when the env value changes`, with `previousSecretExpiresAt` set.
  - `archives a webhook dropped from the file at once`.
  - Delivery (`ownedEndpoints.test.ts`, emit through `POST /v1/webhooks/events` as an emitting test service): `delivers an organization's event to an all-organization endpoint` for two organizations; `does not deliver when the owner cannot read the event` (revoke the owner's access row) ; `signs with the provisioned secret` (verify `X-Webhook-Signature` with the env value).
  - API: `refuses PATCH, DELETE, archive and rotate-secret on a provisioned endpoint with 409 managed_by_provisioning`; `lets webhooks.admin read an all-organization endpoint and its deliveries, retry and test it`; `hides it from a caller without webhooks.admin`.

- [ ] **Step 2: Run to see them fail** — `npx vitest run src/tests/provisioning/provisioning.test.ts -t webhooks src/tests/webhooks/ownedEndpoints.test.ts`; Expected: FAIL.

- [ ] **Step 3: Implement.** Endpoint creation reuses `db.webhookEndpoints.create` with the given plaintext; detect a secret change by opening the stored secret (`openEndpointSecrets`) and comparing. Status of a provisioned endpoint is `ACTIVE` on create and not reset on reapply. A `DISABLED` one stays disabled until an admin re-enables it: `PATCH` on a provisioned endpoint is allowed when the body has only `status`, and is `409 managed_by_provisioning` for any other field (add a test `lets an admin re-enable a disabled provisioned endpoint`).

- [ ] **Step 4: Run to see them pass**, plus `npx vitest run src/tests/webhooks`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(core): service-owned webhook endpoints from provisioning`.

---

### Task 7: Remove registration

**Files:**
- Delete: `packages/tereo/src/routes/v1/registry/`
- Modify: `packages/tereo/src/routes/v1/index.ts` (unmount), `src/definitions/coreScopes.ts` and `src/utils/coreAccess.ts` (drop the `registry` area)
- Modify: `packages/tereo/src/utils/registry.ts` (delete `applyRequestedAccess`, `reopenGrownAccess`, `AccessView`/`listAccess`/`RegisterResult` if unused; `declarationSchema` loses `requestedAccess`)
- Modify: `packages/tereo/src/utils/serviceAccess.ts` (delete `approveProvisionedAccess`, `pendingPermissions` in `withPermissions`; `approveAccessTx` keeps serving the admin re-approve of a revoked row)
- Modify: `packages/tereo/src/routes/v1/admin/services/**` (access list: `status` filter accepts `approved`/`revoked`; drop `pendingAccessCount` from the list)
- Modify: `packages/tereo/src/definitions/eventTypes.ts` (remove `core.service.access-requested`; its removal retires it a day after deploy)
- Modify: `packages/tereo/openapi/**` (remove `/v1/registry/declaration`; update service-access schemas), then `npm run openapi:build`
- Modify: tests: delete registration tests in `src/tests/registry/registry.test.ts` and `serviceDecisionRaces.test.ts` that exercise `/v1/registry/declaration`; move the declared-item semantics they cover (retirement, declared buckets, org-assignable, file_user) to provisioning-based setup in the same files.

**Interfaces:**
- Consumes: Tasks 4–6 (everything a service needs now comes from provisioning).
- Produces: no `/v1/registry` route; `registerDeclaration` used only by `registerCore`.

- [ ] **Step 1: Write the failing test** in `src/tests/routing.test.ts`: `POST /v1/registry/declaration` with a service token answers `404`.
- [ ] **Step 2: Run it to see it fail** — `npx vitest run src/tests/routing.test.ts`; Expected: FAIL (route answers 200/422).
- [ ] **Step 3: Remove the code and port the tests** as listed. Helper for the ported tests: `provisionService({ declaration, access })` in `src/tests/provisioning/utils/test-helpers.ts`, returning `{ slug, namespace, credentials }`, built on `applyProvisioning`.
- [ ] **Step 4: Run the whole suite**
  Run: `cd packages/tereo && npx tsc --noEmit && npx vitest run`
  Expected: PASS; `grep -rn "registry/declaration\|approveProvisionedAccess\|reopenGrownAccess" src` finds nothing.
- [ ] **Step 5: Commit** — `feat(core)!: remove service registration`.

---

### Task 8: CLI and start

**Files:**
- Create: `packages/tereo/src/cli/provision/index.ts`
- Modify: `packages/tereo/src/cli/index.ts` (two commands, usage lines)
- Modify: `packages/tereo/src/utils/provisioning/index.ts` (`provision(options)`)
- Create: `packages/tereo/scripts/provisioning-schema.ts` and `packages/tereo/provisioning.schema.json` (generated, committed); `package.json` script `provisioning:schema`
- Test: `packages/tereo/src/tests/provisioning/cli.test.ts`

**Interfaces:**
- Produces:
  - `provision(options?: { path?: string; dryRun?: boolean }): Promise<ProvisioningResult | null>` — `dryRun` runs validation and the database checks inside the locked transaction, computes the result, then rolls back (throw a private sentinel after computing, catch outside).
  - `runProvisionCli(args: string[]): Promise<void>` — `provision [--path <path>] [--dry-run]`; prints the result as JSON; on `ProvisioningError` prints every problem to stderr and exits 1.
  - `runProvisioningSchemaCli(): void` — prints `z.toJSONSchema(ProvisioningDocumentSchema, { io: "input" })`.
  - `loadKeys()` runs in the CLI before applying (webhook secrets are sealed).

- [ ] **Step 1: Write the failing tests** (spawn `npx tsx src/cli/index.ts …` with a temp folder and the test env):
  - `applies a folder and prints what changed` — exit 0; the service exists.
  - `--dry-run writes nothing` — exit 0; output lists the service under `created`; the service does not exist.
  - `exits 1 listing every problem` — two bad documents: exit 1; stderr has both file names.
  - `prints the JSON Schema` — `provisioning-schema` output parses; `properties.version` exists.
  - `provisioning.schema.json is current` — the committed file equals the generated schema.
- [ ] **Step 2: Run to see them fail** — `npx vitest run src/tests/provisioning/cli.test.ts`; Expected: FAIL.
- [ ] **Step 3: Implement.** Start (`src/index.ts`) keeps calling `provision()` after `registerCore()`, unchanged in behaviour.
- [ ] **Step 4: Run to see them pass.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(core): provision and provisioning-schema CLI commands`.

---

### Task 9: SDK

**Files:**
- Delete: `packages/tereo-sdk/src/clients/registry.ts`, `src/types/registry.ts`, `src/tests/registry.test.ts`, `docs/registry.md`
- Modify: `packages/tereo-sdk/src/coreClient.ts` (drop `register`, `isRegistered`, `getRegistration`, `whenRegistered`, the `canDispatch` registration gate and `registry.close()`)
- Modify: `packages/tereo-sdk/src/index.ts` (exports)
- Create: `packages/tereo-sdk/src/types/provisioning.ts`, `packages/tereo-sdk/provisioning.schema.json` (copied from core by a `prebuild` script `cp ../tereo/provisioning.schema.json .`), `packages/tereo-sdk/docs/provisioning.md`
- Test: `packages/tereo-sdk/src/tests/provisioningTypes.test.ts`

**Interfaces:**
- Produces: exported types `ProvisioningDocument`, `ServiceProvisioning`, `WebhookSubscription`, `LoginClientProvisioning`, `CustomRole` — hand-written TypeScript mirroring the schema's input shape (the SDK must not import core); `package.json` `exports["./provisioning.schema.json"]`.

- [ ] **Step 1: Write the failing test** `matches core's schema`: build a full `ProvisioningDocument` literal (every optional field set), validate it against `provisioning.schema.json` with a small JSON Schema check (add `ajv` as a dev dependency) → valid; a document with an unknown key → invalid.
- [ ] **Step 2: Run to see it fail** — `cd packages/tereo-sdk && npx vitest run src/tests/provisioningTypes.test.ts`; Expected: FAIL.
- [ ] **Step 3: Implement**; outbox dispatch no longer waits for registration (check `canDispatch`'s other conditions stay).
- [ ] **Step 4: Run** `npx tsc --noEmit && npx vitest run`; Expected: PASS.
- [ ] **Step 5: Commit** — `feat(sdk)!: provisioning document types replace register()`.

---

### Task 10: Helm chart

**Files:**
- Modify: `charts/tereo/values.yaml`, `templates/provisioning-configmap.yaml`, `templates/deployment.yaml`, `charts/tereo/README.md`
- Create: `charts/tereo/templates/provision-job.yaml`

**Interfaces:**
- Produces values: `provisioning.documents: {}` (map of name → object), `provisioning.existingConfigMap: ""`, `provisioning.job.backoffLimit: 1`, `provisioning.job.activeDeadlineSeconds: 300`.

- [ ] **Step 1: Write the failing check** — `charts/tereo/tests/provisioning_test.yaml` if the chart uses helm-unittest (check `ls charts/tereo/tests`); otherwise a script `charts/tereo/ci/provisioning-values.yaml` plus assertions in the chart's CI step: with two documents, the ConfigMap has keys `alpha.json` and `beta.json` holding JSON; the deployment sets `PROVISIONING_PATH=/etc/tereo/provisioning` and mounts the ConfigMap as a directory; no `checksum/provisioning` annotation; a Job annotated `post-install,post-upgrade` runs `node dist/cli/index.js provision` (match the image's CLI entry; check `docker/` for how `migrate-and-seed.sh` invokes Node) with `tereo.env` and the same mount. With `existingConfigMap: x`, no ConfigMap is rendered and both mount `x`.
- [ ] **Step 2: Run** `helm template t charts/tereo -f charts/tereo/ci/provisioning-values.yaml` (or `helm unittest charts/tereo`); Expected: FAIL.
- [ ] **Step 3: Implement**; the ConfigMap renders `{{ $name }}.json: {{ toJson $doc | quote }}` per document.
- [ ] **Step 4: Run again**; Expected: PASS. Also `helm lint charts/tereo`.
- [ ] **Step 5: Commit** — `feat(chart): provisioning documents and the provision Job`.

---

### Task 11: Admin UI

**Files:**
- Modify: `packages/tereo-ui/src/features/services/api/types.ts`, `components/ServiceDetail.tsx`, `ServiceAccessSection.tsx`, `AccessTarget.tsx`, `AccessRequestList.tsx`, `ServiceList.tsx` and their tests
- Modify: `packages/tereo-ui/src/features/auth-admin/components/roles/RoleDetail.tsx`, `RoleList.tsx` (+ api types)
- Modify: `packages/tereo-ui/src/features/webhooks/components/endpoints/WebhookEndpointDetail.tsx`, `WebhookEndpointList.tsx` (+ api types)

**Interfaces:**
- Consumes: `provisioned` on roles and endpoints, `ownerService` (`{ id, slug, name }`) and nullable `organizationId` on endpoints, from the API (Tasks 5–6); `ProvisionedBadge` (`src/components/ProvisionedBadge`).

- [ ] **Step 1: Write the failing tests** (Vitest + Testing Library, beside each component):
  - `ServiceDetail`: no pending inbox, no "Approve" for approved rows; "Re-approve" shown on a revoked row; declared version shown.
  - `RoleDetail`: a provisioned role shows "Managed by provisioning" and no edit/delete/permission controls; user assignment controls remain.
  - `WebhookEndpointDetail`: an owned all-organization endpoint shows its owning service and "All organizations", the badge, no edit/delete/archive/rotate controls; deliveries, retry and test remain.
- [ ] **Step 2: Run** `cd packages/tereo-ui && npx vitest run src/features/services src/features/auth-admin/components/roles src/features/webhooks`; Expected: FAIL.
- [ ] **Step 3: Implement.** Remove the pending-access inbox page/route if it exists only for pending requests (check the router), and its nav entry.
- [ ] **Step 4: Run again, plus** `npm run check` (route-prefix check) and `npx tsc --noEmit`; Expected: PASS.
- [ ] **Step 5: Commit** — `feat(ui): provisioned roles and owned webhooks; no access-request inbox`.

---

### Task 12: Docs, release notes and version plans

**Files:**
- Modify: `packages/tereo/docs/provisioning.md` (rewrite), `docs/registry.md` (core's declaration and declared-item semantics only), `docs/webhooks.md` (owned endpoints), `docs/configuration.md` (`PROVISIONING_PATH`), `packages/tereo/.env.example`, `README.md` (*Current state*), `CLAUDE.md` (the "How app services fit in" bullets: registration → provisioning), `packages/tereo-sdk/README.md`
- Create: `.nx/version-plans/core-declarative-provisioning.md` (`core: minor`), `.nx/version-plans/sdk-provisioning-types.md` (`sdk: major`)

- [ ] **Step 1: Write the docs.** `provisioning.md` sections: the path (folder/file, JSON only, ConfigMap mount), documents (`service`, `clients`, `roles`, with one complete example), validation (the rule list from the spec), applying (order, version, access follows the role, removals and grace), webhooks, secrets (kept from today's doc), CLI (`provision`, `--dry-run`, `provisioning-schema`), Helm, migrating from `PROVISIONING_FILE` and from registration (a short checklist: convert YAML to JSON documents; move each service's `register()` declaration into its document; delete `register()` calls).
- [ ] **Step 2: Verify links and leftovers**
  Run: `grep -rn "PROVISIONING_FILE\|registry/declaration\|register()\|requestedAccess\|pendingPermissions" --include=*.md --include=*.ts --include=*.yaml . | grep -v node_modules | grep -v docs/superpowers`
  Expected: no matches outside migration notes.
- [ ] **Step 3: Format and lint the repository**
  Run: `npm run format && npm run sort-imports && npm run lint`
  Expected: clean.
- [ ] **Step 4: Commit** — `docs: declarative provisioning`.

---

## Final verification

- [ ] `cd packages/tereo && npx tsc --noEmit && npx vitest run` — PASS.
- [ ] `cd packages/tereo-sdk && npx tsc --noEmit && npx vitest run` — PASS.
- [ ] `cd packages/tereo-ui && npx tsc --noEmit && npx vitest run && npm run check` — PASS.
- [ ] `docker/test/run.sh` — PASS.
- [ ] `docker compose up` with `PROVISIONING_PATH` pointing at a folder holding the example from `docs/provisioning.md`: core starts, the admin UI shows the service as managed by provisioning.
