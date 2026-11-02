---
"@tereo-io/sdk": patch
---

`provisioning.schema.json` matches core's again: provisioning webhook `events` are capped at 100 and ids are checked as GUIDs, as core has validated them since the server audit.
