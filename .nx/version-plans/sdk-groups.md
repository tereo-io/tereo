---
"@tereo-io/sdk": minor
---

Group requests (`listGroups`, `getGroup`, `createGroup`, `updateGroup`, `archiveGroup`, `restoreGroup`, `listGroupMembers`, `addGroupMembers`, `removeGroupMember`, `setGroupRoles`, `listGroupRoles`, `listUserGroups`; lists take `includeArchived`) and their types, and `groups` in the provisioning document types. `AuthServiceUserRole` now carries `via`, and the user-roles response type `AuthServiceUserRolesResponse` has `groupRoles` (`AuthServiceUserGroupRole`) and `orgGroupRoles` (`AuthServiceUserOrgGroupRole`, with `organization`) beside `roles`. `listUserGroups` returns `UserGroup`s, each with its `organization` (null for a global group).
