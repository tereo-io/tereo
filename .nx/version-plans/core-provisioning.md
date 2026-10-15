---
core: major
---

Breaking: client secrets must now use the `tereo_sk_` format (core-generated ones switch to it, and secrets supplied by a deploy must pass its strength rules); app services can no longer request core admin roles (`admin`, `platform_admin`, `*_admin`), only the roles marked requestable; and core's own login client and clients with `consentRequired: false` no longer show the consent screen after a password login.

A deploy can declare its app services and login clients in a provisioning file (`PROVISIONING_FILE`, or the chart's `provisioning` value). Core applies it at every start, all or nothing, with secrets read from the environment and access pre-approved; its rows are read-only through the admin API (`409 managed_by_provisioning`). Login clients gain an admin-set `audience` and a `consentRequired` flag, `SETUP_TOKEN` lets first-boot setup run unattended, and `npm run cli -- generate-secret` makes a secret in the new format.
