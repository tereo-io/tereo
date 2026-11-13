---
"@tereo-io/mcp": patch
---

The README covers `req.auth` in a host app that imports `@modelcontextprotocol/express` (the MCP SDK's `AuthInfo` type wins there; read Tereo's context with `core.auth.validateUser(req)`), and says to mount `router()` ahead of an app-wide `core.auth.requireAuth`.
