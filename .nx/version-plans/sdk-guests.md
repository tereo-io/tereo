---
"@tereo-io/sdk": minor
---

`core.guests` invites a guest user (`invite`), extends one (`extend`), issues a password-setup link (`issuePasswordSetupLink`) and reads one (`get`). The provisioning document types gain `guestAssignable` on custom roles and the top-level `guests` section. `AuthServiceUser` now always carries `expiresAt` (`string | null`) and `status`, as core returns them for every user.
