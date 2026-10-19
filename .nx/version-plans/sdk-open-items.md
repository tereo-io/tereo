---
"@tereo-io/sdk": major
---

`core.auth.getService()` (`requests.auth.getOwnService()`) returns this service as core knows it, from `GET /v1/account/service`: the provisioning document's version and hash core last applied, when, and its access, so a service can check at start that its deploy's document was applied. `auth.introspectionCacheTtlSeconds` bounds how long an active introspection is cached (default 60, `0` turns caching off). `createCoreClient({ channelPrefix })` takes core's `REDIS_KEY_PREFIX`, so the file cache hears a prefixed core's invalidations. `NotFoundError` is exported. The outbox dead-letters an audit entry whose `source` is not the service's slug at once (core's `422 source_mismatch`), and a row's `last_error` and retry warnings now carry core's status, error code and description. Needs the `core` release with `GET /v1/account/service`.

Breaking changes:

- `validateOrganization` throws `NotFoundError` (`404`) when the resource belongs to another organization, instead of a `403` that confirmed it exists.
- `getServiceAccessToken` sends no scope unless given scopes. The old default, `openid`, was refused for service and integration clients, which hold none; pass it explicitly if a client needs it.
