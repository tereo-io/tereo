---
"@tereo-io/sdk": minor
---

`core.guests` invites a guest user (`invite`), extends one or renames it (`extend`), issues a password-setup link (`issuePasswordSetupLink`), reads one (`get`), lists them (`list`) and reads what an invitation may use (`options`: the guest-assignable roles, the defaults and the longest expiry). The provisioning document types gain `guestAssignable` on custom roles and the top-level `guests` section. `AuthServiceUser` now always carries `expiresAt` (`string | null`) and `status`, as core returns them for every user.
