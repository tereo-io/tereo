---
core: minor
---

Users can report to one other user. An admin with `users.reports.write` sets or clears it (`PUT`/`DELETE /v1/admin/users/:id/reports-to`, the user page), loops refused; deactivation and SCIM deletion keep it. `GET /v1/admin/users/:id/reports?transitive=true` lists everyone below a user, deactivated users included, with `users.read` (`user_resolver`); `auth.user.reports-to-changed` is emitted on each change.
