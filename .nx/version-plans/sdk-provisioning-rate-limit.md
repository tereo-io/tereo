---
"@tereo-io/sdk": minor
---

Provisioning documents accept `rateLimitPerSecond` on `service` and on each of `integrations`, an integer from 1 to 100000 that replaces the account's default request limit; omitting it clears the value. The types and `provisioning.schema.json` carry it.
