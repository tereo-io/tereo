---
"@tereo-io/sdk": minor
---

`recipients` on `EmitEventParams` addresses an event to named services or integrations (`core.webhooks.emit`, `core.outbox.emit`), and the provisioning types gain `internalHost`, `trustedCoreScopes` and an `integrations` section (`IntegrationProvisioning`). Test tokens can name a client (`|client=<id>`), and `createCoreClient({ testServiceUserId })` makes the `service` test user a real UUID. Needs the `core` release with addressed events.
