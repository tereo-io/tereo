---
"@tereo-io/sdk": patch
---

The docs say how `req.auth` is typed in a project that imports `@modelcontextprotocol/express` itself, which declares `req.auth` as its own `AuthInfo`: read the context with `core.auth.validateUser(req)`, typed `AuthContext`, rather than casting. `@tereo-io/mcp` does not load that declaration and exports its own host and origin validation, so an app using it needs no such import.
