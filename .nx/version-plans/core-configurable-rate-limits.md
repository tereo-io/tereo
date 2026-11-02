---
core: major
---

Request rate limits are configurable. `RATE_LIMIT_PER_SECOND`, `RATE_LIMIT_INTERNAL_PER_SECOND`, `RATE_LIMIT_PRE_AUTH_PER_SECOND` and `RATE_LIMIT_PRE_AUTH_INTERNAL_PER_SECOND` (and the chart's `rateLimits`) set the defaults, and a pre-auth value below its general counterpart stops core from starting. A person, service or integration can also carry its own `rateLimitPerSecond`, set in the admin API and UI, or in the provisioning document for provisioned ones; changes are audited and emitted as `auth.user.rate-limit-changed`. `GET /v1/admin/settings` reports the active limits, and `PATCH /v1/admin/settings` now answers 400 to an unknown key instead of ignoring it.
