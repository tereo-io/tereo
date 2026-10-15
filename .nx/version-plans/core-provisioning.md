---
core: minor
---

A deploy can declare its app services and login clients in a provisioning file (`PROVISIONING_FILE`, or the chart's `provisioning` value). Core applies it at every start, all or nothing, with secrets read from the environment and access pre-approved; its rows are read-only through the admin API (`409 managed_by_provisioning`). Login clients gain an admin-set `audience` and a `consentRequired` flag, `SETUP_TOKEN` lets first-boot setup run unattended, and app services may request only the core roles marked requestable. Client secrets use one `tereo_sk_` format with strength rules and `npm run cli -- generate-secret`; core-generated secrets switch to it.
