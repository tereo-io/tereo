# OpenAPI Examples

Real excerpts from `packages/tereo/openapi/` — the one spec, from its `auth`, `webhooks`,
`audit` and `files` files. Some are trimmed (marked `# …`).

## Root openapi.yaml — Path References

`openapi.yaml` keys every path by its full URL on core, mount included, and points at the area's
path file:

```yaml
paths:
  # Auth
  /v1/admin/roles:
    $ref: './paths/auth/admin/roles.yaml#/~1admin~1roles'
  /v1/admin/roles/{id}:
    $ref: './paths/auth/admin/roles.yaml#/~1admin~1roles~1{id}'
  /v1/admin/roles/{id}/archive:
    $ref: './paths/auth/admin/roles.yaml#/~1admin~1roles~1{id}~1archive'
  # …
  # Webhooks
  /v1/webhooks/webhooks:
    $ref: './paths/webhooks/webhooks.yaml#/~1webhooks~1v1~1webhooks'
  /v1/webhooks/webhooks/{id}:
    $ref: './paths/webhooks/webhooks.yaml#/~1webhooks~1v1~1webhooks~1{id}'
  /v1/webhooks/webhooks/{id}/archive:
    $ref: './paths/webhooks/webhooks.yaml#/~1webhooks~1v1~1webhooks~1{id}~1archive'
  # …
```

Note: `/` in paths is escaped as `~1` in JSON pointer references.

## Path File — Auth Admin Action, Permission as Scope (paths/auth/admin/roles.yaml)

From `paths/auth/admin/`, components are `../../../components/…` (shared) or
`../../../components/auth/…`. The permission is the scope on `BearerAuth`; the root `security` plus
`security-defined: error` in `redocly.yaml` make every operation declare one.

```yaml
/admin/roles/{id}/archive:
  post:
    tags:
      - Admin - Roles
    summary: Archive role
    description: |
      Archives a role. The role must be deactivated first
      (`isActive: false`) — archiving an active role returns `409 Conflict`.
      System roles cannot be archived (`403 Forbidden`). Returns `404` when
      the role does not exist, and `409 already_archived` when it is
      already archived.

      An audit log entry is created for this action.
      An `auth.role.archived` webhook event is emitted.
    operationId: archiveAdminRole
    security:
      - BearerAuth: [roles.archive]
    parameters:
      - $ref: '../../../components/auth/parameters.yaml#/RoleIdParam'
    responses:
      '204':
        description: Role archived
        headers:
          X-RateLimit-Limit:
            $ref: '../../../components/headers.yaml#/X-RateLimit-Limit'
          X-RateLimit-Remaining:
            $ref: '../../../components/headers.yaml#/X-RateLimit-Remaining'
          X-RateLimit-Reset:
            $ref: '../../../components/headers.yaml#/X-RateLimit-Reset'
      '401':
        $ref: '../../../components/responses.yaml#/UnauthorizedResponse'
      '403':
        $ref: '../../../components/responses.yaml#/ForbiddenResponse'
        description: Forbidden - missing roles.archive permission, or the role is a system role
      '404':
        $ref: '../../../components/responses.yaml#/NotFoundResponse'
        description: Role not found
      # …
```

## Path File — Archive Action Returning the Resource (paths/webhooks/webhooks.yaml)

```yaml
/v1/webhooks/webhooks/{id}/archive:
  post:
    tags:
      - Webhook Endpoints
    summary: Archive a webhook endpoint
    description: |
      Archives (retires) a webhook endpoint by setting `archivedAt`. Archived
      endpoints never receive event deliveries and are hidden from the default
      list (pass `includeArchived=true` to see them). Archiving is independent of
      `status` and can be applied from any status. Reversible via
      `POST /v1/webhooks/webhooks/{id}/restore`.

      **Required permissions:**
      - `webhooks.archive`

      An audit log entry is created for this action.
    operationId: archiveWebhookEndpoint
    security:
      - BearerAuth: []
    parameters:
      - $ref: '../../components/webhooks/parameters.yaml#/WebhooksIdParam'
    responses:
      '200':
        description: Webhook endpoint archived successfully
        content:
          application/json:
            schema:
              $ref: '../../components/webhooks/schemas.yaml#/WebhookEndpoint'
      '401':
        $ref: '../../components/webhooks/responses.yaml#/WebhooksUnauthorizedResponse'
      '403':
        $ref: '../../components/responses.yaml#/ForbiddenResponse'
      '404':
        $ref: '../../components/responses.yaml#/NotFoundResponse'
      '409':
        $ref: '../../components/webhooks/responses.yaml#/WebhooksConflictResponse'
      '429':
        $ref: '../../components/responses.yaml#/RateLimitResponse'
      '500':
        $ref: '../../components/responses.yaml#/ServerErrorResponse'
```

## Path File — Cursor-Paginated Read (paths/audit/entries.yaml)

```yaml
/v1/audit/entries/entity/{entityType}/{entityId}:
  get:
    tags:
      - Audit Log Entries
    summary: Get entity change history
    description: |
      Returns a paginated list of audit log entries for a specific entity, ordered by most recent first.
      Useful for viewing the complete change history of an entity.

      **Required permission:** `audit-logs.read`

      **Supported sort fields:** `createdAt`
    operationId: getEntityHistory
    security:
      - BearerAuth: []
    parameters:
      - $ref: '../../components/audit/parameters.yaml#/EntityTypeParam'
      - $ref: '../../components/audit/parameters.yaml#/EntityIdParam'
      - $ref: '../../components/audit/parameters.yaml#/EntityHistoryLimitParam'
      - $ref: '../../components/parameters.yaml#/CursorParam'
      - $ref: '../../components/audit/parameters.yaml#/AuditSortParam'
      - $ref: '../../components/parameters.yaml#/SortDirParam'
    responses:
      '200':
        description: Paginated list of audit log entries for the entity
        content:
          application/json:
            schema:
              $ref: '../../components/audit/schemas.yaml#/ListAuditLogEntriesResponse'
      '401':
        $ref: '../../components/audit/responses.yaml#/AuditUnauthorizedResponse'
      # …
```

## Path File — Two-Level Permission, 204 (paths/files/permissions.yaml)

Files states the permission both as the scope and in the description, because bucket-level grants
apply on top of the system permission:

```yaml
/files/buckets/{name}/permissions/{userId}:
  delete:
    tags:
      - Files - Permissions
    summary: Revoke bucket permission
    description: |
      Revokes all permissions for a user on a bucket (soft delete).

      **Required permissions:**
      - System: `file-service.permissions.delete` AND bucket owner
    operationId: revokeBucketPermission
    security:
      - BearerAuth: [file-service.permissions.delete]
    parameters:
      - $ref: '../../components/files/parameters.yaml#/BucketNameParam'
      - $ref: '../../components/files/parameters.yaml#/FilesUserIdParam'
    responses:
      '204':
        $ref: '../../components/responses.yaml#/NoContentResponse'
      '401':
        $ref: '../../components/files/responses.yaml#/FilesUnauthorizedResponse'
      '403':
        $ref: '../../components/responses.yaml#/ForbiddenResponse'
        description: Forbidden - missing file-service.permissions.delete permission or no bucket access
      '404':
        $ref: '../../components/responses.yaml#/NotFoundResponse'
        description: Bucket, user, or permission not found
      # …
```

## Schema — Resource with Nullable Fields (components/webhooks/schemas.yaml)

```yaml
WebhookEndpoint:
  type: object
  description: A webhook endpoint configuration for receiving event notifications
  properties:
    id:
      type: string
      format: uuid
      description: Unique identifier
      examples:
        - "550e8400-e29b-41d4-a716-446655440000"
    organizationId:
      type: string
      format: uuid
      description: |
        Tenant identifier — an `Organization.id` (UUIDv7).
        Bootstrap-time endpoints register under the default organization.
    description:
      type: [string, 'null']
      description: Optional description of the webhook endpoint
      maxLength: 500
    status:
      $ref: '#/WebhookEndpointStatus'
    customHeaders:
      type: [object, 'null']
      additionalProperties:
        type: string
      description: Custom HTTP headers to include in webhook deliveries
    archivedAt:
      type: [string, 'null']
      format: date-time
      description: Archive (retirement) timestamp; null for active endpoints. Archived endpoints never receive deliveries.
      examples:
        - "2025-01-15T10:30:00.000Z"
    # …
```

A nullable ref (`components/files/schemas.yaml`, `Bucket`):

```yaml
    corsConfig:
      description: Optional per-bucket CORS override. Null when unset.
      oneOf:
        - $ref: '#/CorsConfig'
        - type: 'null'
```

## Schema — Cursor-Paginated List Response

```yaml
ListWebhookEndpointsResponse:
  type: object
  description: Cursor-paginated list of webhook endpoints
  properties:
    data:
      type: array
      items:
        $ref: '#/WebhookEndpoint'
    hasMore:
      type: boolean
      description: Whether there are more records beyond the current page
    limit:
      type: integer
      description: The page size requested (echoed back from the request)
    nextCursor:
      type: [string, 'null']
      description: |
        Opaque, HMAC-signed cursor for fetching the next page. `null` when
        `hasMore` is `false`. Pass back as the `cursor` query parameter on the
        next request. Bound to the request's `sort` + `sortDir`.
```

## Webhook Definition (paths/auth/admin/roles.yaml)

At the end of the path file, referenced from the root `webhooks:` section as
`auth.role.archived: { $ref: './paths/auth/admin/roles.yaml#/auth.role.archived' }`:

```yaml
auth.role.archived:
  post:
    tags:
      - Admin - Roles
    summary: Role archived
    description: Fired when a role is archived.
    operationId: webhookRoleArchived
    parameters:
      - $ref: '../../../components/parameters.yaml#/WebhookIdHeader'
      - $ref: '../../../components/parameters.yaml#/WebhookEventHeader'
      - $ref: '../../../components/parameters.yaml#/WebhookTimestampHeader'
      - $ref: '../../../components/parameters.yaml#/WebhookSignatureHeader'
    requestBody:
      required: true
      content:
        application/json:
          schema:
            allOf:
              - $ref: '../../../components/webhook-schemas.yaml#/OrganizationWebhookEvent'
              - type: object
                properties:
                  eventType:
                    const: auth.role.archived
                  entityType:
                    const: Role
                  data:
                    type: object
                    required: [id, name]
                    properties:
                      id:
                        type: string
                        format: uuid
                      name:
                        type: string
    responses:
      '2XX':
        description: Any 2xx response acknowledges the delivery; anything else is retried.
```

## Webhook Delivery Headers (components/parameters.yaml)

Shared by every area's webhook definitions:

```yaml
WebhookIdHeader:
  name: X-Webhook-Id
  in: header
  required: true
  description: |
    The delivery id (one per event per endpoint); stable across retries, so it
    can be used to deduplicate. Not the body's `id`.
  schema:
    type: string
    format: uuid

WebhookTimestampHeader:
  name: X-Webhook-Timestamp
  in: header
  required: true
  description: |
    Unix time in seconds at which this attempt was signed, as an integer
    string. Part of the signed input.
  schema:
    type: string
    pattern: '^[0-9]+$'
    examples:
      - '1767225600'

WebhookSignatureHeader:
  name: X-Webhook-Signature
  in: header
  required: true
  description: |
    `sha256=` followed by the hex HMAC-SHA256, keyed with the endpoint's
    signing secret, of `"<X-Webhook-Timestamp>.<raw request body>"`.

    During the 24 hours after the endpoint's secret is rotated it lists one
    signature per secret, comma-separated, current secret first
    (`sha256=<new>,sha256=<old>`); accept the request if any value matches.
  schema:
    type: string
    pattern: '^sha256=[0-9a-f]{64}(,sha256=[0-9a-f]{64})*$'
# … WebhookEventHeader
```

## Binary Download Endpoint (paths/files/objects.yaml)

```yaml
/files/buckets/{name}/objects/by-id/{id}/versions/{versionId}/download:
  get:
    tags:
      - Files - Objects
    summary: Download a specific version's bytes by id
    operationId: downloadObjectVersionById
    security:
      - BearerAuth: [file-service.objects.read]
    parameters:
      - $ref: '../../components/files/parameters.yaml#/BucketNameParam'
      - $ref: '../../components/files/parameters.yaml#/ObjectIdParam'
      - $ref: '../../components/files/parameters.yaml#/VersionIdParam'
    responses:
      '200':
        description: |
          Version content. `Content-Type` reflects the stored version's MIME
          type (falls back to `application/octet-stream`).
        headers:
          Content-Type:
            $ref: '../../components/files/headers.yaml#/Content-Type'
          Content-Length:
            $ref: '../../components/files/headers.yaml#/Content-Length'
          ETag:
            $ref: '../../components/files/headers.yaml#/ETag'
          X-Content-Type-Options:
            $ref: '../../components/files/headers.yaml#/X-Content-Type-Options'
          # … Cache-Control, X-RateLimit-*
        content:
          '*/*':
            schema:
              type: string
              format: binary
```

## redocly.yaml

`packages/tereo/redocly.yaml`, for the one spec:

```yaml
extends:
  - recommended

apis:
  core:
    root: openapi/openapi.yaml
    output: openapi/bundled-openapi.yaml

rules:
  # Localhost server URLs are intended.
  no-server-example.com: off
  security-defined: error
```

Problems skipped on purpose go in `packages/tereo/.redocly.lint-ignore.yaml`, keyed by
file, rule and JSON pointer — today only `operation-2xx-response` for the redirect-only operations:

```yaml
openapi/paths/auth/oauth.yaml:
  operation-2xx-response:
    - '#/~1oauth~1authorize/get/responses'
```
