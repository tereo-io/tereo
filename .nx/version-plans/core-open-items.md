---
core: major
---

App services can read what core knows about them, and core is safer to run alongside others. `GET /v1/account/service` returns the calling service's row, the provisioning document's version and hash core last applied, when, and its access, with no permission needed. A service can read the audit entries it wrote (its slug as `source`, its account as writer) across every organization, through the new requestable core role `audit_reader` or the `audit_writer` it already holds. `REDIS_DB` selects the Redis database and `REDIS_KEY_PREFIX` prefixes every key, channel, BullMQ queue and socket.io key, so several cores can share one Redis; the chart gains `redis.db` and `redis.keyPrefix`, plus `provisioning.job.enabled` and `provisioning.job.annotations` to turn off or annotate the provisioning Job. Every process, whatever its `ROLE`, creates today's and tomorrow's partitions before its first audited write, so a start no longer fails when they are missing. Client, role, service and integration responses show `unprovisionedAt`, and dropping one from the provisioning documents, or bringing it back, emits its update event carrying it. A client keeps the hashes of every secret it retired (migration `retired_secret_hashes`), and provisioning refuses any of them. An admin resetting a user's credentials or removing their access is checked under a per-user lock that every role change for that user also takes, so a concurrent grant of a stronger role can no longer slip past the check.

Breaking changes:

- A service's client may write only audit entries whose `source` is its own slug; any other is `403`, and refuses the whole batch.
- The slugs `core` and `tereo` are reserved for services and integrations, in provisioning documents and through the admin API.
- Provisioning refuses any retired client secret, whether rotated away, revoked or replaced, for that client and every other. A deploy that reuses one fails at start; generate a fresh secret.
- Client, role, service and integration responses, and their events, gain `unprovisionedAt`. `core.service.updated` always carries it, and dropping an integration or a custom role from the documents now emits `core.integration.updated` or `auth.role.updated`.
- Some admin errors come in a different order: `DELETE /v1/admin/users/:id/sessions` naming a session that does not exist answers `404` before a `403`.
