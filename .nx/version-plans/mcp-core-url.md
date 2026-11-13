---
"@tereo-io/mcp": patch
---

Without `coreUrl`, the start check fetches core's authorization-server metadata from the URL the given `CoreClient` was created with (`core.url`), and only then from `CORE_URL`, so a service that configures its core client from its own settings no longer has to pass `coreUrl` too. Where `createCoreClient({ url })` and `CORE_URL` differ, the metadata now comes from the client's URL, not from `CORE_URL`. This release's `@tereo-io/sdk` peer range requires the SDK release that adds `core.url`; a core client without it (from an older SDK) still falls back to `CORE_URL`.
