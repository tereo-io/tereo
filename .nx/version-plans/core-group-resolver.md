---
core: minor
---

Core declares `group_resolver`, a role an app service may request in its provisioning document's `access.roles`: it grants `groups.read`, so a service can read a group by id and tell a missing group (404) from one that exists, which it could not with `user_resolver` alone (403 for both).
