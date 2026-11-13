---
"@tereo-io/sdk": patch
---

The docs say how `req.auth` is typed in a project that also loads `@modelcontextprotocol/express`, which declares `req.auth` as its own `AuthInfo`: read the context with `core.auth.validateUser(req)`, typed `AuthContext`, rather than casting.
