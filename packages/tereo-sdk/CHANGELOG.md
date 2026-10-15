## 0.2.0 (2026-10-15)

### 🩹 Fixes

- Dependencies updated within their ranges: `axios` 1.20, `zod` 4.6, `pino` 10.4, `express` 5.3 and `form-data` 4.0.6, among others. ([#1](https://github.com/tereo-io/tereo/pull/1))
- The package ships its TypeScript sources beside `dist/`, so its source maps and declaration maps resolve: a debugger steps into the SDK's own code, and an editor's go-to-definition opens it. ([#1](https://github.com/tereo-io/tereo/pull/1))

### ⚠️  Breaking Changes

- The SDK now uses `ioredis` 6. The `redis` client passed to `createCoreClient` must be an `ioredis` 6 client: upgrade the app's own `ioredis` to `^6.0.0`, which needs Node.js 20 or later. ([#1](https://github.com/tereo-io/tereo/pull/1))

### ❤️ Thank You

- Aaron Leman