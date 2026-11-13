---
core: minor
---

Core declares `group_resolver`, a role an app service may request in its provisioning document's `access.roles`. It grants `groups.read`: read-only, and global like the other resolver roles, so the service reads every group, global and in every organization. It can list and search them (archived ones too), read each group, its roles, its members with their names, emails and active flag, and its SCIM skipped members (names and emails), and its provisioned webhooks receive `auth.group.*` events (group fields, member user ids, role ids). It tells a missing group (404) from one that exists, which a service could not with `user_resolver` alone (403 for both). A provisioning set in which a service in a namespace named `group` declares a system role `group_resolver`, or a document defines a custom role of that name, now fails provisioning, since neither may share a name with one of core's roles.
