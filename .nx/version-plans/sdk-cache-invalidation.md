---
"@tereo-io/sdk": minor
---

`AuthServiceClient` gains `invalidateToken(token)`, `invalidateUser(...userIds)` and `invalidateOrganization(...ids)`, which drop the cached introspection result, user or organization for every replica of the service, so an app that learns of a revocation need not wait out the cache TTL. Defaults are unchanged; the README and `docs/auth.md` now state how stale each cache can be.

`uploadObject` takes an optional `expectedSize` for a stream body, sent when the multipart upload is initiated; core now requires it in a bucket with a quota. The notification send types gain `sensitive`.
