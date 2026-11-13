---
"@tereo-io/sdk": minor
---

`core.auth.listUserGroups(userId, { includeArchived })` returns a user's groups and `core.auth.getGroup(id)` a group, each `null` when core answers 404 and otherwise rejecting with the `RequestError` (`httpStatus` set to core's answer). Neither is cached. In `testMode`, `listUserGroups` returns no groups and `getGroup` a stub for any id.
