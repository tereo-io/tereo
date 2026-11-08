---
"@tereo-io/sdk": minor
---

Email verification in the SDK: users carry `emailVerified` and `emailVerifiedAt`, and `core.auth.users.sendVerificationEmail(id)` asks core to email a user a verification link (`409 already_verified`, `user_not_verifiable`, `email_not_configured`); `UsersClient` is exported from the package root. In `testMode`, `getUser` returns a verified user.
