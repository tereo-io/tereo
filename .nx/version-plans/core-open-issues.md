---
core: minor
---

Fixes for the open issues #27, #28, #30, #32, #33, #34 and #35.

- **Postgres pool settings (#27).** `DB_POOL_MAX` (default 20), `DB_POOL_MIN` (5) and `DB_POOL_CONNECTION_TIMEOUT_MS` (10000) size core's Postgres pool. A `connection_limit` in `DATABASE_URL` still has no effect.
- **Readiness (#30).** `GET /health/ready`, also on the worker's health port, returns 200 while core serves and 503 `draining` once shutdown starts. It does not ping Postgres or Redis. The chart's readiness probe now uses it; the startup probe stays on `/health`. Point external load balancer health checks at it too. `/health` pings Postgres on a connection of its own, outside the request pool, which adds one connection per process.
- **Managed users (#33).** `GET /v1/admin/users/{id}` returns `managedBy` (`{ kind: "system" }`, `{ kind: "service" | "integration", id, name }`, or `null`). The user page hides Edit, Manage Roles, the 2FA reset and identity invites for those accounts and says who manages them.
- **Email port and security (#34).** Email connections refuse port 465 with `starttls` and port 587 with `tls`. A stored connection with either pair reads as `invalid_settings`, and its deliveries fail at once instead of retrying. The form's security follows the port until it is picked by hand, and warns about a mismatch. `GET /v1/admin/notifications/connections` gives each connection a `lastDeliveryError`, which the Connections list shows.
- **Field-level validation errors (#32).** `invalid_request` errors list each failed check in `issues` (`{ path, message }`). The role form states the name rule and checks it before sending, and the organization form does the same for the slug. The role modals show core's refusal inside the modal instead of in a toast. Toasts now sit above modals.
- **Narrow screens (#35).** At 768px and below, the top nav folds into a menu button and the section sidebar becomes a drawer that starts closed. The theme toggle and user menu stay in the top bar.
- **Docs (#28).** `docs/integrations.md` has an "Order of creation" section for organizations, roles and integrations.
