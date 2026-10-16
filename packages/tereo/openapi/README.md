# Tereo API spec

One OpenAPI 3.1 spec for the whole service, served on core's one port (`http://localhost:4001`
locally). Every path is keyed by its full URL on core. Core's own API is under `/v1`; OAuth2 / OIDC,
discovery and `/health` stay at the root.

| Area | Mounted at | Covers |
|------|-----------|--------|
| Auth | `/oauth`, `/.well-known`, `/v1` | OAuth2 / OpenID Connect, `/.well-known`, `/v1/account`, `/v1/admin` (users, clients, roles, permissions, organizations, settings, services), first-boot `/v1/setup`, `GET /health` |
| Files | `/v1/files` | Buckets, objects, multipart, archives, lifecycle, bucket permissions, shares, signed URLs |
| Webhooks | `/v1/webhooks` | Webhook endpoints and deliveries, event types, event emission |
| Audit | `/v1/audit` | Audit log entries |
| Notifications | `/v1/notifications`, `/v1/admin/notifications` | Sending and a send's status; the log and retry; channels and connections (settings, sealed secrets, default, test send) |

Files under `paths/` key their operations by the pre-`/v1` path (`/files/buckets`, `/audit/v1/entries`):
those keys are only `$ref` anchors. The published path is the key in `openapi.yaml`.

The root `webhooks:` section lists every event core delivers: `auth.*`, `core.service.*`,
`file-service.*` and `webhook.test`. Every event type in `src/definitions/eventTypes.ts` has one.

`openapi.yaml` is the entry point; `bundled-openapi.yaml` is generated from it. Don't edit the
bundle by hand.

## Lint and bundle

From `packages/tereo` (config: `redocly.yaml`; skipped problems:
`.redocly.lint-ignore.yaml`):

```sh
npm run openapi:lint    # lint the spec — CI runs this
npm run openapi:build   # lint, then regenerate bundled-openapi.yaml
```

## Layout

```
openapi/
├── openapi.yaml            # info, servers, security, tags, x-tagGroups, path $refs, components, webhooks
├── bundled-openapi.yaml    # generated
├── components/
│   ├── headers.yaml        # Retry-After, X-RateLimit-*
│   ├── schemas.yaml        # UserRef, OrgRef, ServiceRef, RoleRef
│   ├── parameters.yaml     # pagination, sort, filter, includeArchived, webhook delivery headers
│   ├── responses.yaml      # the common error responses
│   ├── security.yaml       # BearerAuth, ClientCredentials
│   ├── webhook-schemas.yaml  # WebhookEvent envelope, OrganizationWebhookEvent, WebhookHeaders
│   ├── auth/               # parameters, responses (OAuth2 errors, archived, …), schemas
│   ├── files/              # headers (ETag, Content-*), parameters (incl. signed-URL query params),
│   │                       #   responses (413, 507, idempotency, signature rejected), schemas
│   ├── webhooks/           # parameters, responses, schemas
│   ├── audit/              # parameters, responses, schemas
│   └── notifications/      # parameters, responses, schemas
└── paths/
    ├── auth/               # health, well-known, oauth, oauth-upstream, oauth-org-select, account,
    │   │                   #   account-identities, setup, and admin:
    │   └── admin/          #   clients, identity-providers, organizations, permissions, roles, services,
    │                       #   settings, signing-keys, users, user-identities
    ├── files/              # buckets, lifecycle, objects, multipart, archives, permissions, shares,
    │                       #   signed, webhook-events (file-service.* definitions)
    ├── webhooks/           # webhooks (+ webhook.test), event-types, events
    ├── notifications/      # send, connections, admin-log
    └── audit/              # entries
```

Components every area uses alike are defined once in `components/*.yaml`; where an area's version
differs it lives in `components/<area>/` under a prefixed name (`FilesConflictResponse`,
`AuditSortParam`, `WebhooksLimitParam`, …). Webhook definitions sit in the path file for their
resource (auth) or in `paths/files/webhook-events.yaml`, and are referenced from the root
`webhooks:` section.

Conventions (relative `$ref`s, permissions, public operations with `security: []`, optional auth on public-bucket reads with
`security: [ {}, { BearerAuth: [] } ]`, nullable as
`type: [string, 'null']` or `oneOf: [{ $ref }, { type: 'null' }]`) are in
`.claude/skills/openapi/SKILL.md`.
