---
core: minor
---

Declarative provisioning replaces service registration. A folder (or one file) of JSON provisioning documents declares each app service with its permissions, system roles, buckets, event types, access and webhook subscriptions, plus login clients and custom roles. Core validates the whole set across documents, reports every problem naming its file, and applies it in one transaction at every start and with `npm run cli -- provision` (`--dry-run` writes nothing to the provisioned state; `provisioning-schema` prints the JSON Schema). Access listed in a document follows the role and is granted without an approval step; access removed from it is revoked, and an admin's revocation stays. Services can own webhook endpoints (`ownerService`, `provisioned`, all organizations with a null `organizationId`), and provisioned custom roles and endpoints are read-only through the admin API (`409 managed_by_provisioning`). The Helm chart renders the documents as a ConfigMap and runs `provision` as a post-install and post-upgrade Job.

Breaking changes:

- `PROVISIONING_FILE` (YAML) is now `PROVISIONING_PATH` (JSON file or directory of `*.json` files). An empty directory is an error.
- Registration is removed: `POST /v1/registry/declaration` no longer exists, and neither does the `registry` scope area. Services stop calling the SDK's `register()`.
- Helm: the `provisioning` value is now `provisioning.documents` (a map of file name to document) or `provisioning.existingConfigMap`; a provisioning change no longer rolls core's pods.
- The admin UI's Access Requests page is removed, the `core.service.access-requested` event type is retired, and access requests left pending by registration are deleted by the migration.
- Services that registered a declaration on 0.2.0 are adopted by the migration as provisioned. A service missing from the documents once provisioning runs is deactivated after `REGISTRY_RETIREMENT_GRACE_HOURS`.
- A service's account does not hold its own permissions: a webhook on the service's own events needs a role in `access.roles` granting the event's read permission. Provisioned webhook URLs may not be `localhost` or a private or reserved IP literal.

Migration checklist:

1. Convert the YAML file to JSON documents (`{ "version": "…", "service": { … } }`, `clients`, `roles`) and set `PROVISIONING_PATH`; in Helm, move the `provisioning` value under `provisioning.documents`.
2. Move each service's `register()` declaration into its document, with the same `slug`, `namespace` and `clientId`, and list the roles and audiences it requested under `access`. Every registered service needs a document, or it is deactivated after the grace period.
3. Delete the `register()`, `isRegistered()`, `whenRegistered()` and `getRegistration()` calls from services.
4. Run `npm run cli -- provision --dry-run` against the new documents before deploying; the CLI needs `REDIS_URL` as well as the database and the `secretFrom` variables.
