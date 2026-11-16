---
core: minor
---

An OAuth client can be given `liveEvents` (admin UI, admin API, or `liveEvents: true` on a provisioning document's login client). Users' tokens from such a client open core's socket without `core:events` and hear `auth:permissions:changed` and their own session's `auth:session:revoked`; the token stays without core access everywhere else, so a service in its audience still sees the user's full permissions at introspection. `auth:permissions:changed` is now also sent when a user's organization roles or membership change (reasons `org_roles_changed`, `org_membership_changed`), so sockets opened with `core:events` hear those changes too.
