---
core: major
---

Access tokens no longer carry a `permissions` claim. A token's size grew with every permission its holder's roles granted, so a broad role (57 permissions here) produced a token longer than `/oauth/introspect` and `/oauth/revoke` accepted, and the claim went stale the moment a role was revoked. Nothing in core, the SDK or the admin UI read it: core and introspection compute permissions live from the database on every request. `/oauth/introspect` and `/oauth/revoke` now accept tokens up to 8192 characters.

Breaking changes:

- A service that verifies core's access tokens itself (against the JWKS) and reads `permissions` from them gets none. Read them from `/oauth/introspect` (what the SDK's `requireAuth` already does) or ask `/oauth/check-permission`.
