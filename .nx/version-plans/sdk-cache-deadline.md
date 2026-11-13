---
"@tereo-io/sdk": patch
---

The SDK's cache commands (introspection, user, organization and file metadata caches) give up after one second and fall through to core, as on a Redis error. With the `maxRetriesPerRequest: null` the SDK asks for, ioredis holds a command while it reconnects until Redis is back, so during an outage a cache read held the request that made it. A Redis that answers within a second behaves as before. The README describes what else waits on Redis during an outage.
