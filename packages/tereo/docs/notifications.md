# Notifications area

Outbound messages from core and its app services, mounted at `/v1/notifications` (send, read one) and
`/v1/admin/notifications` (connections, log). Email is the only channel. A send is stored, queued
through the outbox, and delivered by a worker; the caller gets `202` once it is stored. Every route
needs a bearer token and is rate limited.

Tables are in the `notifications` schema: `connections`, `notifications` and `deliveries` (the last
two daily-partitioned). The code is in `src/utils/notifications/` (accept, connections, the channel
adapters), `src/jobs/notification*.ts` and `src/routes/v1/notifications/`.

## Permissions

All three are global-only.

| Permission            | Covers                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `notifications.send`  | `POST /v1/notifications`, and reading one's own sends                                                 |
| `notifications.read`  | Reading any notification (other senders' included), the log, channels and connections (never secrets) |
| `notifications.admin` | Creating, changing, deleting and testing connections, setting the default, retrying. Includes `.read` |

`notifications.send` sits outside the read/write/archive/delete/admin ladder
(`utils/permissions.ts`): `notifications.admin` does **not** include it. To send, a caller needs
`notifications.send` itself, or the global `admin` permission, which covers everything.

An app service sends through the system role `notification_sender`, which holds
`notifications.send`. Its provisioning document lists the role in `access.roles` ([provisioning](provisioning.md));
until that is applied, its sends are refused.

## Channels

`GET /v1/admin/notifications/channels` lists the channels core supports with the JSON schema of each
one's connection `settings` and `secrets`. Only `email` exists; an unknown channel is
`400 unknown_channel`.

### Email

Sent over SMTP with nodemailer.

- Settings: `host`, `port`, `security` (`tls`, `starttls` or `none`), optional `username`,
  `defaultFrom` (`{ address, name? }`; `name` must not contain `<`, `>`, `@` or `"`) and `allowedSenders` (at least one address or `@domain`;
  `defaultFrom` must match). `security: "none"` (plaintext, the password included) is refused
  unless `ALLOW_PLAINTEXT_SMTP=true` ([configuration.md](configuration.md)): on create and update,
  and for a stored connection, which then reads as `400 invalid_settings` and fails its deliveries
  with `invalid_settings`.
- Secrets: `password`, optional.
- Content: `subject` (1-998 characters, no line breaks), `text` and/or `html` (one is required), and
  optional `from` (`{ address, name? }`) and `replyTo`. A `from` address and a `replyTo` must each
  match the connection's `allowedSenders`, else `400 sender_not_allowed`; without a `from` the
  connection's `defaultFrom` is used. A `from.name` containing `<`, `>`, `@` or `"` is
  `400 invalid_content`: a name that reads like an address would show a sender the allowlist
  never checked.
- Recipients: at most 50, at least one `to`. Each is `{ address }` or `{ userId }`, plus `as`
  (`to`, `cc` or `bcc`; default `to`). A person's `userId` resolves to their email address.
  Addresses are stored lower-cased, as given or resolved, so the log's recipient filter matches
  any case.
- Attachments: at most 20 MB in total. The sender's access to each attachment's bucket is checked at
  accept and again when the delivery is sent, as at accept: the sender's live permissions and
  grants, in the token's organization and capped by its scopes (both stored on the notification as
  `sender_access`, never returned). Access lost in between fails the delivery permanently with
  `attachment_forbidden`; core's own sends read every bucket. As in the files API, a public
  bucket's history is not public: at accept, a version that is no longer current takes a grant on
  the bucket (or `file-service.admin`), and is `attachment_not_found` without one.
- An address named twice is sent to once, at the most visible `as` (`to` over `cc` over `bcc`).
  One email is one delivery.
- `Message-ID` is `<delivery id>@<from domain>`.
- SMTP timeouts are 30 s to connect, 60 s of silence, and 10 minutes for the whole send, under the
  stale sweep's 15. A `5xx` reply is permanent
  (`smtp_rejected`); anything else is retried.
- When the 10-minute deadline passes, nodemailer cannot cancel the send still in flight, so the
  delivery is retried as a timeout. No mail is lost, at the cost of a rare duplicate if the server
  completes the late send as well. This is deliberate.

## Connections

A connection is one configured way to send through a channel (for email, one SMTP account). There is
one default per channel; the first connection created becomes it. A send without `connection` uses
the default at delivery time.

Paths are under `/v1/admin/notifications/connections`.

| Method and path     | Permission | Purpose                                                                                                                                             |
| ------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`             | `read`     | List, optionally `?channel=email`. Answers `{ data }`                                                                                               |
| `POST /`            | `admin`    | Create. Body: `channel`, `slug`, `displayName`, `settings`, optional `secrets`, `isEnabled`, `maxPerMinute`                                         |
| `GET /:id`          | `read`     | One connection                                                                                                                                      |
| `PATCH /:id`        | `admin`    | Change `displayName`, `settings`, `secrets`, `isEnabled`, `maxPerMinute`. An omitted field is kept; `secrets: null` clears them                     |
| `DELETE /:id`       | `admin`    | `204`. Refused with `409 connection_in_use` once any notification used it (disable it instead), and with `409 connection_is_default` while it is the default and the channel has others |
| `POST /:id/default` | `admin`    | Make it the channel's default                                                                                                                       |
| `POST /:id/test`    | `admin`    | Body `{ to }`. Sends a test message now and answers `{ ok: true, providerResponse }` or `{ ok: false, error }`; the call itself is `200` either way |

- `slug` is lowercase letters, digits and hyphens, unique per channel (`409 slug_taken`).
- Secrets are write-only. They are sealed in the row with the key-encryption key
  (`sealRowSecret`, name `notification-connection:<id>`) and responses carry only `hasSecrets`. A
  value sealed under a previous key is re-sealed when next opened.
- Invalid settings or secrets are `400 invalid_settings` / `invalid_secrets`, with `details.issues`.
- While secrets are stored, a `PATCH` changing a setting that says where they go (the adapter's
  `secretBoundSettings` — email: `host`, `port`, `security`, `username`) must send `secrets` too
  (new ones, or `null`), otherwise `400 secrets_required`. Without it, an admin could point the
  connection at their own server and `POST /:id/test` would hand it the stored password.
- `maxPerMinute` (null: no limit) is a fixed one-minute window in Redis, per connection. A delivery
  over the limit is delayed to the next window without using an attempt.
- Creates, updates, deletes and tests are audited. Create, update and delete emit
  `notification.connection.created`, `.updated` and `.deleted` (data never includes secrets). An
  update that replaces or clears the secrets records `metadata: { secretsChanged: true }` or
  `{ secretsCleared: true }`, never the values.
- The SMTP host is resolved and pinned to a public address before connecting. If it resolves to a
  private or reserved address the delivery fails with the fixed text "The SMTP host resolves to a
  private or reserved address" (code `host_not_allowed`), never the address itself. A host that does
  not resolve is retried. `NOTIFICATIONS_ALLOW_PRIVATE_HOSTS=true` turns the check off for local
  development and is refused in production ([configuration.md](configuration.md)).
- Transports are cached for five minutes, keyed on the connection id and a hash of its settings,
  secrets and the private-hosts flag, so an edit takes effect on the next send.

## Sending

### From the API

`POST /v1/notifications`, `notifications.send`. Answers `202 { id, status: "pending" }`.

```json
{
  "channel": "email",
  "connection": "ops-smtp",
  "organizationId": null,
  "recipients": [
    { "address": "ap@example.com" },
    { "userId": "0198...", "as": "cc" }
  ],
  "content": { "subject": "Invoice 1042", "text": "Attached." },
  "attachments": [
    {
      "bucket": "invoices",
      "objectId": "0198...",
      "versionId": "0198...",
      "filename": "1042.pdf"
    }
  ],
  "idempotencyKey": "invoice-1042-sent"
}
```

- `connection` is a slug; omit it for the channel's default. The body is strict: unknown keys are
  `400 invalid_request`.
- A recipient gives exactly one of `address` and `userId`. Options are strict too: a misspelt `as`
  is refused rather than ignored, so a bcc cannot end up in `To`. A `userId` must be an active
  person with an address for the channel.
- At most 50 attachments, each a version of an object in core's file storage, named by bucket,
  object id and version id. The sender must be able to read the bucket. The version is pinned, and
  its bytes are read from storage when the message is sent. `filename` defaults to the last part of
  the object's key.
- Everything is checked before anything is stored, in the order a sender would fix it. Nothing is
  written on failure.
- The send is audited (`CREATE` on `Notification`) and written with its delivery rows and an outbox
  row in one transaction.

Errors:

| Status | Code                                    | When                                                                                                                             |
| ------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `unknown_channel`, `unknown_connection` | No such channel, or no connection with that slug                                                                                 |
| 400    | `invalid_content`                       | Content, recipients or options fail the channel's rules, a user has no address, a NUL character appears, or an email has no `to` |
| 400    | `sender_not_allowed`                    | `content.from` or `content.replyTo` is not in the connection's `allowedSenders`                                                  |
| 400    | `too_many_recipients`                   | More than the channel's cap (50)                                                                                                 |
| 400    | `unknown_user`, `inactive_user`         | A `userId` that does not exist or is not an active person                                                                        |
| 400    | `unknown_organization`                  | `organizationId` does not exist                                                                                                  |
| 400    | `attachment_not_found`                  | No such object or live version in a bucket the sender can read, or the object is in the trash                                    |
| 400    | `attachments_too_large`                 | Total over the channel's limit                                                                                                   |
| 403    | `attachment_forbidden`                  | The sender cannot read the bucket; a missing bucket reads like an unreadable one, so a sender can't probe for names              |
| 403    | `forbidden`                             | `organizationId` is outside the caller's organization scope (below)                                                              |
| 409    | `connection_disabled`                   | The named connection is disabled                                                                                                 |
| 400    | `invalid_request`                       | The body's shape is wrong, including unknown keys                                                                                |

Accept-time checks that need a connection (the `from` sender check) run against the named
connection, else the channel's current default, even when that default is disabled. With no named
connection and no default yet, the send is accepted and waits for one (see Delivery).

`organizationId` scopes the notification in the audit log and on its `notification.sent` and
`.failed` events. Left out (or null) it is the token's organization, or the default organization
when the token has none (and for `notifyTx`). Naming one is limited the way audit writes are
(`assertNotificationWriteScope` in `middleware/organizationId.ts`); a refusal is `403 forbidden`,
checked before the organization's existence so a refused caller can't probe ids:

- A token with an `org_id` may name only that organization.
- An app service's token without an `org_id` may name any.
- Anyone else's token without an `org_id` (a person's, an integration's) may name none.
- `notifications.admin` may name any.
- Leaving `organizationId` out (or null) is always allowed, and means the token's organization.
- `notifyTx` is unrestricted.

### Idempotency

`idempotencyKey` is in the body, as on audit writes, and is scoped by the authenticated user and
the route. The same key with the same body replays the stored `202`, without validating again, so a
replay answers even if a connection, user or bucket grant has changed since. The same key with a
different body is `422 idempotency_key_conflict`; a second request while the first is running is
`409 idempotency_request_in_progress`. The claim and result lifetimes and failure handling are the
audit area's ([audit.md](audit.md#idempotency)).

### From core

`notifyTx(tx, input)` (`src/utils/outbox.ts`) takes the same input inside the caller's transaction.
It runs the same checks as the API, as the system user, with every bucket readable and no
`organizationId` restriction, and nothing is sent unless the transaction commits. It returns
`{ id }`. Core renders the message itself; there are no templates.

### From an app service

List the role in the app's provisioning document, and once it is applied the app can send:

```json
{ "version": "1.0.0", "service": { "slug": "orders-service", "access": { "roles": ["notification_sender"] } } }
```

- `core.notifications.send(input)` calls `POST /v1/notifications` and returns `{ id, status }`.
  It generates an `idempotencyKey` when none is given, so the handler's retries send once.
  `core.notifications.get(id)` reads one back with its deliveries.
- `core.outbox.notify(tx, input)` writes the send in the app's own transaction; the SDK's reaper
  relays it after commit, at least once, with the row id as `idempotencyKey`. A 4xx other than
  401, 403, 408, 409 or 429 dead-letters the row. It rejects an unknown channel, a recipient
  count core would refuse (1 to 50) or an email with no `to` recipient immediately.

### Reading a send

`GET /v1/notifications/:id` returns the notification, its `summary` and its deliveries (status,
attempts, `lastError`, `providerMessageId`, `sentAt`). `summary` is one line from the channel's
adapter (`summarize`; for email, the subject), written at accept and kept after the content is
dropped, so the log can show what a send was. `notifications.read` sees any; `notifications.send`
only the caller's own. Another sender's id is `404`, the same as an unknown one.

Notification `status` is `pending`, `sent` (every delivery sent), `failed` (every delivery failed)
or `partial` (settled, mixed). A delivery is `pending`, `sending`, `sent` or `failed`.

## Delivery

1. The accept transaction writes the notification, its deliveries and a `notification` row in
   `core.outbox`.
2. The outbox reaper's `notification` dispatcher queues each pending delivery on the channel's
   BullMQ queue, `notifications-<channel>`. The job id is the delivery id, so a delivery has at most
   one live job.
3. The worker takes the connection (the named one, else the channel's default now), takes a rate
   token, marks the delivery `sending`, re-checks the sender against the connection, and sends.

Outcomes:

- **Sent.** The delivery is marked sent with the provider's message id and reply, the notification
  status is rolled up, and one `notification.sent` event is emitted for that delivery. The
  notification's `content` is dropped once every delivery is sent. Recipients the server refused
  at `RCPT` while it accepted others don't fail the delivery; `providerResponse` ends with
  `; rejected: <addresses>`. If recording the send fails, it is retried in-process (3 tries); if it
  still fails, the error is logged with `deliveryId` and `providerMessageId` and the delivery stays
  `sending` for the stale sweep, which sends it again.
- **Permanent failure** (`PermanentSendError`, or a `BadRequestError` such as `sender_not_allowed`
  after a default changed): marked `failed` at once, with `notification.failed`. `lastError` is the
  SMTP reply for `smtp_rejected`, else the error code (`attachment_missing`, `host_not_allowed`, ...).
- **Other errors:** back to `pending` with `lastError` set, retried by BullMQ with exponential
  backoff from 60 s. There are 8 attempts in all. The count is also kept on the delivery, so a
  re-queue by the stale sweep does not add attempts. After the last it is `failed`; a delivery
  the sweep puts back with no attempts left is failed without sending, keeping its `lastError`
  (or `attempts_exhausted`).
- **No connection** (none exists, or the one in use is disabled): `lastError` is `no_connection`
  and the job waits 60 s and tries again, without using an attempt.

Events go to webhook subscribers like any other ([webhooks.md](webhooks.md)). Types:
`notification.sent`, `notification.failed`, `notification.connection.created`,
`notification.connection.updated` and `notification.connection.deleted`.

`notification.sent` and `.failed` are one per delivery, not per notification: `data` is
`{ id, channel, deliveryId, status, connection }`, where `id` is the notification, `status` is its
rolled-up status at that moment and `connection` the slug used (null only for a delivery failed
for running out of attempts before any connection was used). They carry the notification's
`organizationId`, or the default organization. The connection events carry
`{ id, channel, slug, displayName, isDefault, isEnabled }`, never secrets, in the default
organization.

Stale deliveries: a delivery left `sending` for 15 minutes lost its worker. A sweep every 5 minutes
puts it back to `pending` and queues it. It may already have gone out, as SMTP cannot be asked, so
a recipient can in rare cases get a message twice. The same sweep queues up to 500 deliveries left
`pending` for 2 hours, longer than the longest backoff (64 minutes), so a delivery waiting for its
next attempt is not among them; queueing one that still has a job is a no-op, so only a delivery
whose job was lost runs.

Each write that settles a delivery applies only from the status it expects, so a late writer
changes nothing. A worker's result (sent, failed, back to pending) applies only while the delivery
is still `sending`. Two writes apply from `pending`: failing a delivery that has used all its
attempts, and keeping one `pending` while no connection is available. One more covers a send that
outlived the stale sweep: the worker records it as sent from `pending`, so the re-queued job skips
it, and logs a warning. If that job has already claimed it again, the message may go out twice.

## Admin log and retry

Paths are under `/v1/admin/notifications`.

| Method and path   | Permission            | Purpose                                                                       |
| ----------------- | --------------------- | ----------------------------------------------------------------------------- |
| `GET /`           | `notifications.read`  | The log, across organizations, newest first                                   |
| `GET /:id`        | `notifications.read`  | One notification with its deliveries; `content` is included while kept        |
| `POST /:id/retry` | `notifications.admin` | Re-queue the notification's `failed` deliveries                               |

The list is cursor-paged: `?limit=` (default 50, at most 200) and `?cursor=`, answering
`{ data, hasMore, limit, nextCursor }`. Lists leave `content` out. Each entry carries `summary` (for
email, the subject) and `sentAt`, when its most recently sent delivery went out (null until one
has). Filters:

- `filter[channel]`
- `filter[status]`: one status, or several with `filter[status_op]=in` and a comma-separated value
- `filter[senderUserId]`
- `filter[recipient]`: an exact address, any case, matched against every delivery's recipients.
  It has no index and no date bound of its own, so it scans every partition; add a
  `filter[createdAt_*]` range on a large log.
- `filter[createdAt_gte]`, `filter[createdAt_lte]`

The detail adds `content` and the deliveries, each with the provider's last reply
(`providerResponse`). An unknown id is `404`.

Retry resets the notification's `failed` deliveries to `pending` with their attempt count back at
0, rolls its status up again and queues them through the outbox. It answers `{ requeued }` (how
many were reset) and is audited (`UPDATE` on `Notification`, `metadata: { retried }`). A
notification with no failed delivery is `409 nothing_to_retry`.

`content` is kept while any delivery is unsent, so a failed delivery can be retried until retention
removes it. Once every delivery is sent it is gone.

## Operating

- Each channel's queue is worked with concurrency 10 per worker process.
- Redis backs the BullMQ queues, the per-connection rate window and idempotency keys. With Redis
  down, sends carrying an `idempotencyKey` get `503` rather than risk a double send, and nothing is
  delivered until it returns; accepted notifications stay in Postgres and the outbox.
- `lastError` on a delivery means:

| Value                           | Meaning                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `no_connection`                 | No enabled connection to send through; the job waits and retries every 60 s. Create, enable or set a default connection |
| `host_not_allowed`              | The SMTP host resolves to a private or reserved address. Permanent                                                      |
| `The SMTP host did not resolve` | DNS failed; retried. The worker logs the DNS error (`SMTP host did not resolve`, with `connectionId`)                  |
| `attachment_missing`            | An attached version is no longer stored, or its object or bucket is in the trash. Permanent                             |
| `attachment_forbidden`          | The sender can no longer read an attachment's bucket (grant or permission revoked, or the sender deactivated). Permanent |
| `sender_not_allowed`            | `content.from` or `content.replyTo` is not allowed on the connection used at delivery, e.g. the default changed since accept. Permanent |
| `smtp_rejected`                 | Shown as the server's `5xx` reply text. Permanent                                                                       |
| anything else                   | The error's message, e.g. a connection or `4xx` SMTP reply; retried up to 8 attempts                                    |

## Retention

Notifications and deliveries are dropped by day partition after 30 days, by a daily job that first
creates the next seven days' partitions, each under a 5-second `lock_timeout` (one that finds its
table locked is left for the next run). A partition is detached and dropped in one transaction
under the same `lock_timeout`; one that fails, finds its table locked or deadlocks with a write
(the drop also locks the table on the other side of the foreign key) is logged and left for the
next run, and so is that day's notifications partition, which its deliveries reference. The
job also drops any old `notifications_YYYY_MM_DD` / `deliveries_YYYY_MM_DD` table left detached
but not dropped. After that `GET` answers `404` and a queued job for a
dropped delivery is skipped.

## Adding a channel

Everything the generic code needs from a channel is its adapter; the tables, endpoints, queue
handling and audit do not change.

1. **Enum value.** Add it to `enum NotificationChannel` in `prisma/schema.prisma` and write the
   migration (`migrate dev --create-only`), and to the `NotificationChannel` type in
   `src/utils/notifications/channels/types.ts`. The connection routes' `z.enum(["email"])` in
   `routes/v1/admin/notifications/connections/schemas.ts` takes it too.
2. **Adapter.** Write `src/utils/notifications/channels/<channel>.ts` implementing `ChannelAdapter`:
   `settingsSchema`, `secretsSchema`, `contentSchema`, `recipientOptionsSchema` (strict),
   `maxRecipients`, `maxAttachmentBytes` (null: no attachments), `validate`, `summarize` (the log's
   one-line `summary`), `resolveUser`, `plan`
   (splits one send into deliveries; email makes one, an SMS channel would make one per number),
   `send` (throw `PermanentSendError` for failures a retry cannot fix) and `test`. Register it in
   `ADAPTERS` in `channels/index.ts`.
3. **Queue.** Nothing to add by hand: the worker starts one BullMQ worker per entry in `CHANNELS`
   (`startNotificationDeliveryWorker`), named `notifications-<channel>`. Check that the queue's
   concurrency and the connection's `maxPerMinute` suit the provider.
4. **Admin form.** Add the channel's settings and secrets form under
   `packages/tereo-ui/src/features/notifications/components/connections/` (see
   `EmailConnectionForm.tsx`) and select it in `ConnectionFormModal.tsx`; extend the channel type in
   `api/types.ts`. The connection list, default switch and test modal are channel-agnostic.

Add tests for the adapter and for a send through it.
