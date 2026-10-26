# Error codes

Every error core returns has one shape:

```json
{ "error": "not_found", "error_description": "Role not found" }
```

`error` is the code to branch on; `error_description` is for people and may change. A few codes add
fields after these two (`retry_after` on a `429`, `requiresPassword` on a share's
`password_required`). A validation failure (`invalid_request`, and a notification connection's
`invalid_settings` / `invalid_secrets`) lists each failed check in `issues`, as
`{ path, message }` with `path` the dotted field (`roleIds.0`, `""` for the whole value), so a form
can show each message under its field. The full list per operation is in the OpenAPI spec (`openapi/`); this page is
the rule set the codes follow.

In code, every error is one of the classes in `src/utils/errors.ts`, thrown to the error handler.
Where nothing can be thrown — a stream's `error` event after the controller has returned —
`sendError(res, err)` writes the same body and headers. Never `res.status(…).json(…)` an error.

The handler logs a 5xx at `error` with the error under `err`, anything else at `warn`; the path has no
query string and no share token (`redactUrl`). A `PrismaClientValidationError` reprints the query,
values included, so only its first line is logged (`loggableError`), and a files access-log row keeps
just a Prisma error's class and code (`accessLogErrorMessage` in `middleware/accessLog.ts`).

## Shared codes

One condition, one code, in every area:

| Status | Code                                                     | Meaning                                                                                                                                                                                               |
| ------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request`                                        | Validation failed, or the body is not valid JSON / form data                                                                                                                                          |
| 400    | `unknown_user` / `unknown_organization` / `unknown_role` | An id in the request **body** names no user / organization / assignable role                                                                                                                          |
| 400    | `file_upload_required`                                   | A multipart upload has no `file` part                                                                                                                                                                 |
| 401    | `unauthorized` / `invalid_token`                         | Missing, or invalid / expired / revoked, access token                                                                                                                                                 |
| 403    | `forbidden`                                              | Not permitted                                                                                                                                                                                         |
| 404    | `not_found`                                              | The resource in the **URL** does not exist, or is hidden from the caller                                                                                                                              |
| 408    | `request_timeout`                                        | The request's body did not arrive in time; the connection is closed. See [configuration.md](configuration.md#http-limits)                                                                             |
| 409    | `slug_taken` / `name_taken`                              | The slug (organizations, services, integrations, identity providers, notification connections) or name (roles) is already used, archived rows included. An organization's `code` answers `code_taken` |
| 409    | `conflict`                                               | Already exists, still in use, or another state conflict without its own code                                                                                                                          |
| 409    | `resource_archived`                                      | The resource is archived and read-only; restore it first                                                                                                                                              |
| 409    | `already_archived`                                       | Archive of a resource that is already archived                                                                                                                                                        |
| 409    | `not_archived`                                           | Restore of a resource that is not archived                                                                                                                                                            |
| 409    | `idempotency_request_in_progress`                        | A request with the same idempotency key is still running                                                                                                                                              |
| 413    | `payload_too_large`                                      | Body or upload over the limit                                                                                                                                                                         |
| 422    | `idempotency_key_conflict`                               | An idempotency key reused with a different request                                                                                                                                                    |
| 429    | `too_many_requests`                                      | Rate limited; see below                                                                                                                                                                               |
| 500    | `server_error`                                           | Unexpected failure                                                                                                                                                                                    |

| 503 | `temporarily_unavailable` | A dependency (Redis) is down; retry after `Retry-After` |

## Archived resources

Organizations, roles and webhook endpoints share one rule. A `404` means only that the resource is
not there, or not visible to the caller. Acting on it in the wrong archive state is a `409`:

- `POST …/archive` on an archived resource: `already_archived`
- `POST …/restore` on one that is not archived: `not_archived`
- any other change to an archived resource: `resource_archived`

Reads, restore and (for roles and webhook endpoints) a hard `DELETE` stay open on an archived
resource. `guardArchived` (`src/utils/guardArchived.ts`) enforces this on the per-id routers.

## Rate limits

Every `429` — the general and pre-auth limits, failed-credential limits (login, client secrets,
2FA, account password and TOTP, setup), per-bucket limits and share unlock — is:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 30

{ "error": "too_many_requests", "error_description": "…", "retry_after": 30 }
```

`retry_after` and `Retry-After` carry the same number of seconds. Throw
`TooManyRequestsError(retryAfter, message?)`; the error handler sets both. The general and per-bucket
limits add `X-RateLimit-*` headers.

## Specific codes

An area keeps its own code where a client plausibly branches on it, e.g. `user_not_in_organization`,
`masked_header_value`, `bucket_declared` / `bucket_retired`, `managed_by_provisioning` (409: a
service or login client declared in the provisioning file), `role_assigned_in_org`,
`blocked_file_type`, `invalid_event_type`, `reserved_event_type`. Pass it to the class
(`ConflictError(message, "bucket_retired")`, `BadRequestError(code, message)`) rather than
building an `AppError` by status.

The OAuth and OIDC endpoints (`/oauth/*`, `/.well-known/*`) keep the RFC 6749 / 6750 / OIDC codes
(`invalid_request`, `invalid_grant`, `invalid_client`, `invalid_scope`, `login_required`, …).
