# Cross-service role access (vanquished gap 0k)

Date: 2026-10-16. Status: design approved in conversation; spec awaiting review.

## Problem

Vanquished's services call each other with their own client-credentials tokens, and most of those
calls need a role another service declares (`pricing-service` needs `product-service/product_reader`
to hold `product.read`). Against tereo 0.2.0 this cannot be set up:

- `applyRequestedAccess` (`utils/registry.ts`) refuses the whole declaration with
  `422 invalid_requested_access` when a requested `<slug>/<name>` does not resolve. A consumer that
  boots before the service owning the role cannot register at all, and mutual pairs (oms ↔
  order-routing, customer ↔ shipping, customer ↔ pricing) can never both register.
- The provisioning file's `access.roles` (`utils/provisioning/load.ts`) accepts only requestable
  core roles, so a deploy cannot pre-approve another service's role. Every cross-service grant needs
  an admin click, which blocks unattended environments and vanquished's dev-seed.
- Approved access to another service's role reopens to `pending` whenever that role gains
  permissions, and only an admin can re-approve it. Under GitOps every release that grows a role
  would 403 until someone clicks.

## Goals

- Declarations never fail because of boot order.
- A deploy can pre-approve `<slug>/<name>` roles in the provisioning file.
- Access listed in the file follows the role as it grows, without an admin.
- Admin decisions still stand: a revoked request is never re-approved automatically.

## Non-goals

- Assigning roles to service accounts directly (`/v1/admin/roles/.../users`) stays refused; service
  access is only ever an access request.
- Hand-made (non-file) access keeps today's behaviour, growth included.
- Webhook subscriptions (0i), login clients, audit reads: separate specs.

## Design

### 1. Unresolved requests are recorded, not refused

In `applyRequestedAccess`, a role target of the form `<slug>/<name>` that `resolveRoleTarget` does
not find — the slug has no service yet, the role is not declared yet, or it is retired — is
recorded as a `pending` request like any other. It is not a problem.

Still refused with `422 invalid_requested_access`, every problem listed, nothing applied:

- `core/<name>` (core roles are named bare);
- a bare name that is not a core role, or is a core role services may not request;
- a target whose part after the slash is empty, or with more than one slash;
- a slug equal to the requesting service's own (a service does not request its own roles).

Requests are additive as today, so a row recorded unresolved keeps its id and status when the
target later resolves.

**Visibility.** `AccessView` (registration response, `listAccess`) and the admin access rows gain
`targetDeclared: boolean` — true for audiences and for roles that resolve. The admin UI's access
target (`features/services/components/AccessTarget.tsx`) shows an "Awaiting declaration" badge when
it is false. An admin approving such a row gets the existing `422 role_unavailable`.

### 2. Provisioning accepts other services' roles

`access.roles` entries may be a requestable core role (bare, as today) or `<slug>/<name>`. The
second form is checked for shape only — slug matching the slug pattern, a non-empty name, not the
entry's own slug, not `core/…`. The target service need not be in the file or exist: that is the
boot-order case this fixes. `docs/provisioning.md`'s rule row and example change accordingly.

### 3. File-listed access is approved wherever it becomes approvable

A row is **file-eligible** when its consuming service is provisioned and not unprovisioned, the row
is a role or audience listed in `provisionedAccess`, its target resolves, and its status is
`pending` with either

- `decidedAt` null (never decided — today's rule), or
- a live assignment (`assignment` not null): approved before and reopened because the role grew.

`revoked` rows are never eligible, so an admin revocation stands through growth, re-declaration and
restarts. One helper decides eligibility and is used by every path below.

Approval is `approveAccessTx` as today: actor `SYSTEM_USER_ID`, `checkGrantable: false`, recording
the role's current permissions in `approvedPermissionIds`, audited and emitting
`core.service.access-approved` with the newly granted permissions.

Paths that approve:

| When | Where | Rows |
|------|-------|------|
| Consumer registers (today) | `postDeclaration`, after commit, `approveProvisionedAccess(consumer)` | The consumer's eligible rows |
| Provisioning applies at start (today) | `provisioning/apply.ts` | Every provisioned service's eligible rows |
| **Target declares a role** (new) | Inside `registerDeclaration`'s transaction, after `applyRoles` | Other services' eligible, never-decided rows naming `<this slug>/<role>` |
| **Target's role grows** (new) | Inside `reopenGrownAccess` | Rows it would reopen that are file-eligible |

For growth, a file-eligible row is not flipped to `pending` at all: it is re-approved in place, and
`reopenGrownAccess` neither audits it as `access_requested` nor emits
`core.service.access-requested` for it. Rows that are not file-listed reopen exactly as today.

**Locks.** The two new paths run in the declaring service's registration transaction, which already
holds that service's registry lock. They only touch rows naming the declaring service's own roles,
so `lockRoleOwners` takes the same (re-entrant, transaction-scoped) advisory lock, and
`lockedAudience` then locks the consumer's client row — the admin path's order, registry before
client. No other service's registry lock is taken, which is what the existing comment in
`routes/v1/registry/controllers.ts` guards against. The plan must confirm this with a concurrency
test (target registration racing an admin decision on the same consumer).

Doing this in the transaction, rather than after commit, means no window in which file-listed
access sits `pending` (or emits a spurious access-requested event) and nothing to recover if the
process dies between commit and approval.

### 4. SDK

No change. `register()` keeps retrying with backoff; it simply stops seeing boot-order 422s, so
services report ready as soon as they register. A request still pending means `403` on the calls
that need it, as today.

## Docs

- `docs/registry.md`: "Registering" (the retry bullet no longer mentions roles that do not exist
  yet), "Access needs approval", "Another service's role" (file-listed growth), "Provisioned
  services".
- `docs/provisioning.md`: the `access.roles` rule row and example, "Pre-approved access" (the two
  new approval points; growth of file-listed access; revocations still stand).
- `packages/tereo-sdk` docs if they describe the 422 retry case.

## Testing

Under `src/tests/` (registry and provisioning suites), with services from `tests/utils/testService.ts`:

- Consumer declares `<target>/<role>` before the target exists: `200`, row `pending`,
  `targetDeclared: false`. Target registers with the role: row `approved` (file-listed) or still
  `pending` with `targetDeclared: true` (not listed).
- Mutual pair, both boot orders, both file-listed: both end `approved`.
- Still 422: `core/file_user`, `admin`, own slug, malformed targets.
- File-listed growth: target adds a permission to the role; consumer's row stays `approved`,
  `approvedPermissionIds` include it, the consumer's token has it, no
  `core.service.access-requested` emitted, an `access_approved` audit entry by the system user.
- Unlisted growth: reopens to `pending` with `pendingPermissions`, as today.
- Revoked row: stays `revoked` through growth, re-declaration and a provisioning re-apply.
- Unprovisioned consumer (dropped from the file): growth reopens as for hand-made access.
- Provisioning load: accepts `product-service/product_reader`; refuses `core/file_user`, its own
  slug, `a/b/c`, `x/`.
- Concurrency: target registration and an admin revoke on the consumer's row, run together, end
  consistent (no deadlock; the revoke stands or is applied after).
- UI: `AccessTarget` shows the badge when `targetDeclared` is false.

## Release

`core` release group, minor bump (`npm run version-plan`): unresolved requests no longer fail and
`targetDeclared` is additive. No migration: eligibility uses existing columns.
