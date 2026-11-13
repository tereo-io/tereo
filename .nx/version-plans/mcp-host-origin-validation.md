---
"@tereo-io/mcp": minor
---

`hostHeaderValidation(allowedHosts)` and `originValidation(allowedOrigins)`, exported from `@tereo-io/mcp`, are Express middleware for an app that mounts `router()`: the Host and Origin checks `listen` applies, compared by hostname as the MCP SDK does. With them the app no longer imports `@modelcontextprotocol/express`, whose `req.auth` declaration replaces `@tereo-io/sdk`'s `AuthContext` in the app's types. The README says what to do in an app that imports that package anyway (read Tereo's context with `core.auth.validateUser(req)`), and to mount `router()` ahead of an app-wide `core.auth.requireAuth`.
