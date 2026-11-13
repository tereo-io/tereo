---
"@tereo-io/mcp": patch
---

Without `coreUrl`, the start check fetches core's authorization-server metadata from the URL the given `CoreClient` was created with (`core.url`), and only then from `CORE_URL`, so a service that configures its core client from its own settings no longer has to pass `coreUrl` too. With a core client from an SDK that has no `core.url`, it falls back to `CORE_URL` as before.
