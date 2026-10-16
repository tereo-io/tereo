---
"@tereo-io/sdk": major
---

The SDK no longer registers services with core. `register()`, `isRegistered()`, `whenRegistered()` and `getRegistration()` are removed, along with registration's retry logic and its part in readiness. The SDK now exports the types of a provisioning document (`ProvisioningDocument`, `ServiceProvisioning`, and the rest) and its JSON Schema, so a service's build writes its own document with `JSON.stringify` from a typed object and the deploy hands it to core.

Migration checklist:

1. Move the declaration passed to `register()` into the service's provisioning document (`service.permissions`, `systemRoles`, `buckets`, `eventTypes`), and `requestedAccess` into `service.access`.
2. Delete the `register()`, `isRegistered()`, `whenRegistered()` and `getRegistration()` calls. Calls to core are accepted as soon as the document is applied, and the outbox no longer waits for registration.
3. Needs core with provisioning (the `core` release that removes `POST /v1/registry/declaration`).
