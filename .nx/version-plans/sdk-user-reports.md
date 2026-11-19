---
"@tereo-io/sdk": minor
---

`listUserReports(userId, { transitive })` reads who reports to a user, directly or at any depth (deactivated users included), with `users.read`; `core.auth.users.setReportsTo` and `clearReportsTo` change it with `users.reports.write`.
