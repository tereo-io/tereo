---
core: minor
---

Integrations, support access and a few gaps closed. An integration is a machine client for an external party (`/v1/admin/integrations`, an `integrations` section of a provisioning document), org-bound or platform, that holds roles, is audience-limited, and manages its own webhook endpoints. An event can be addressed to named services or integrations with `recipients` (up to 50 slugs; an unknown slug is `400 unknown_recipient`, or a dead letter from the outbox). A service's provisioning document can set `internalHost`, the one private address its own webhooks may reach; a provisioned login client can set `trustedCoreScopes` to skip consent for named core scopes. New core scopes `core:events` (the socket only) and `core:organizations` (with `GET /v1/account/organizations`), and a global-only permission `organizations.support-access`, held by `organizations.admin` and `admin`, lets its holders sign in into any active organization, audited and announced by `auth.organization.support-access`. Inline PDFs are served without the `sandbox` CSP directive so browsers' viewers render them, and provisioning revokes a client's tokens when a role swaps one permission for another.

Migration notes:

- The migration adds `core.services.internal_host`, `auth.oauth_clients.trusted_core_scopes`, and the integrations model (`kind`, a nullable `namespace`, `organization_id`, two CHECK constraints). `integrations` becomes a reserved namespace.
- `/v1/admin/services` lists app services only; integrations are under `/v1/admin/integrations`.
- Webhook endpoint responses' `ownerService` gains `kind` (`service` or `integration`).
- The 403 `insufficient_scope` message names the request path.
