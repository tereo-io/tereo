---
"@tereo-io/sdk": minor
---

**Breaking:** the SDK now uses `ioredis` 6. The `redis` client passed to `createCoreClient` must be an `ioredis` 6 client: upgrade the app's own `ioredis` to `^6.0.0`, which needs Node.js 20 or later.
