# Writing your provisioning document — @tereo-io/sdk

A service does not register itself at boot. Its build writes a **provisioning document**: a JSON
file that says what the service owns (permissions, system roles, buckets, event types, webhook
subscriptions) and the access it asks for. The deploy pipeline collects the file and puts it in
core's provisioning folder; core reconciles it at start. A running service never writes it.

The types are exported from `@tereo-io/sdk`: `ProvisioningDocument`, `ServiceProvisioning`,
`WebhookSubscription`, `LoginClientProvisioning`, `CustomRole`, and the item types
`PermissionProvisioning`, `SystemRoleProvisioning`, `BucketProvisioning`, `EventTypeProvisioning`.
They mirror core's schema, so a misspelled or unknown key is a compile error. Core's own
[provisioning notes](../../tereo/docs/provisioning.md) say how documents are loaded and reconciled.

## In the build

Write the document as a typed object, and serialize it to a file named after the service
(`billing.json`) as a build step:

```ts
// scripts/provisioning.ts
import { writeFileSync } from "node:fs";

import type { ProvisioningDocument } from "@tereo-io/sdk";

const doc: ProvisioningDocument = {
  version: process.env.npm_package_version!,
  service: {
    slug: "billing",
    name: "Billing",
    secretFrom: "BILLING_CLIENT_SECRET",
    access: { roles: ["file_user", "webhook_publisher"], audiences: [] },
    permissions: [
      { name: "billing.invoices.read", displayName: "Read invoices" },
      { name: "billing.invoices.write", displayName: "Write invoices", orgAssignable: true },
    ],
    systemRoles: [
      {
        name: "billing_editor",
        displayName: "Billing editor",
        permissions: ["billing.invoices.read", "billing.invoices.write"],
      },
    ],
    buckets: [{ bucketName: "billing-invoices", policy: "private" }],
    eventTypes: [
      {
        eventType: "billing.invoice.created",
        description: "An invoice was created",
        readPermission: "billing.invoices.read",
      },
    ],
    webhooks: [
      {
        key: "ledger",
        url: "https://ledger.example.com/hooks/billing",
        events: ["billing.invoice.created"],
        secretFrom: "LEDGER_HOOK_SECRET",
      },
    ],
  },
};

writeFileSync("billing.json", JSON.stringify(doc, null, 2) + "\n");
```

- `version` is the release's semver. A document older than the one applied last is still applied
  (a deliberate rollback); core logs a warning naming both versions.
- Secrets are never in the file: `secretFrom` names an environment variable in **core's**
  environment.
- Optional fields take the schema's defaults (`policy` `"private"`, `orgAssignable` `false`,
  `webhooks[].organizations` `"all"`, and so on).
- A document needs at least one of `service`, `clients` (`LoginClientProvisioning[]`, sign-in
  clients for apps) or `roles` (`CustomRole[]`).

## Editor validation

The package ships core's JSON Schema as `@tereo-io/sdk/provisioning.schema.json`. Point the
document's `$schema` line at it and an editor flags unknown keys and bad values as you type:

```json
{
  "$schema": "./node_modules/@tereo-io/sdk/provisioning.schema.json",
  "version": "1.0.0"
}
```

`$schema` is allowed in the document and ignored by core. The `ProvisioningDocument` type has
the same optional `$schema` field.

## Deploying it

The pipeline collects each service's file into core's provisioning folder and restarts or
re-provisions core; the service's image does not carry or write it. Event types the service emits
must be listed in its document; the client's `eventTypes` option is only a local typo check.
