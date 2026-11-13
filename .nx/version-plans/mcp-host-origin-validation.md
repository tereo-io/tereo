---
"@tereo-io/mcp": minor
---

`hostHeaderValidation(allowedHosts)` and `originValidation(allowedOrigins)`, exported from `@tereo-io/mcp`, are Express middleware for an app that mounts `router()`: the Host and Origin checks `listen` applies, compared by hostname as the MCP SDK does. With them the app no longer imports `@modelcontextprotocol/express`, whose `req.auth` declaration replaces `@tereo-io/sdk`'s `AuthContext` in the app's types.
