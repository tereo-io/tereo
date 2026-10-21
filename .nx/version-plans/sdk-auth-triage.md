---
"@tereo-io/sdk": major
---

`req.auth` carries the token's `clientId`, `scope` and `audience`; `requireScope(...scopes)` refuses a token missing any of them (`403 insufficient_scope`), and `auth.allowedClients` limits which clients' tokens `requireAuth` accepts. `oauthClientId` is deprecated in favour of `clientId`.

Breaking changes:

- `testMode` throws unless `NODE_ENV` is `test` or `development`.
- `introspectionCacheTtlSeconds` must be between 0 and 300.
- `AuthContext` gains required fields `clientId`, `scope` and `audience`; hand-built contexts must set them.
