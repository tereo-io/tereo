# Webhooks — @tereo-io/sdk

Two halves: `core.webhooks` (`WebhookServiceClient`, `src/clients/webhooks.ts`) emits events to core,
which fans them out to subscribed endpoints; `createWebhookVerifier` (`src/utils/webhookVerify.ts`)
verifies core's signature on a delivery an app receives. Types in `src/types/webhooks.ts`.

## Emitting

**Events that must not be lost go through the [outbox](outbox.md)** — `core.outbox.emit(tx, event)`
in the transaction that makes the change. The methods here send directly; the outbox reaper is their
main caller.

`EmitEventParams`: `{ organizationId, eventType, entityType, entityId, data, idempotencyKey? }`.
`idempotencyKey` is held by core for 24 hours per caller (the service's account), organization and
event type; the outbox sets it to the row id. When omitted, one is generated per event and call, so the request handler's retries emit it once.

| Method | Returns | |
|--------|---------|---|
| `emit(event)` | `void` | Best-effort: calls `emitAsync` and logs any failure |
| `emitAsync(event)` | `{ deliveriesCreated }` | `POST /v1/webhooks/events`; throws on failure |
| `emitBatch(events)` | `void` | Best-effort; events with an unknown type are skipped |
| `emitBatchAsync(events)` | `{ results: [{ eventType, entityId, deliveriesCreated }] }` | `POST /v1/webhooks/events/batch`; throws on failure |
| `assertEventType(eventType)` | `void` | Throws `UnknownEventTypeError` if the type is not one the client knows. `outbox.emit` calls it |
| `useEventTypes(eventTypes)` | `void` | Replaces the known types |

Event types are declared in the service's [provisioning document](provisioning.md), not here. The
client knows them only from `createCoreClient({ eventTypes })` and then rejects any other before a
request is made. Before it knows any, it accepts every type and leaves
the check to core, which answers 400 for an event type nobody declared (or a retired one) and 403
for one another service owns. The service needs the `webhook_publisher` role. A batch takes at most
100 events.

`WebhookServiceClient.noop()` returns a client whose methods do nothing — see [testing](testing.md).

## Receiving

```ts
import { createWebhookVerifier } from "@tereo-io/sdk";

app.post(
  "/hooks/core",
  express.json({
    verify: (req, _res, buf) => {
      (req as typeof req & { rawBody: Buffer }).rawBody = buf;
    },
  }),
  createWebhookVerifier(() => process.env.CORE_WEBHOOK_SECRET),
  handleDelivery
);
```

`createWebhookVerifier(getSecret)` returns Express middleware that checks:

- `X-Webhook-Timestamp` (Unix seconds) is within 5 minutes of now;
- `X-Webhook-Signature` is `sha256=<hex HMAC-SHA256(secret, "${timestamp}.${body}")>`, where `body`
  is the raw request body: `req.rawBody` (the `verify` hook above), or `req.body` when it is a
  `Buffer` or string (`express.raw({ type: "application/json" })`, `express.text()`). Without
  either it falls back to `JSON.stringify(req.body)`, which fails for bodies whose re-serialization
  differs — integer-like keys, `1.0`, escaped characters. For 24 hours after core rotates
  an endpoint's secret, the header lists one `sha256=` value per secret, comma-separated; the request
  passes when any of them matches.

It answers 403 when `getSecret()` returns nothing, and 401 for missing headers, a bad or stale
timestamp, or no matching signature. Comparison is constant-time.

**Deduplicate on `X-Webhook-Id`.** Delivery is at least once: the same delivery arrives again
when your response was lost or slower than core's 30-second timeout, when core crashed before
recording an attempt's outcome, or when an admin retries it. Every attempt carries the same
`X-Webhook-Id` — the delivery id, not the body's `id` — with a fresh timestamp and signature.
After verifying, record the ids you have processed and answer `2xx` without processing again
when one comes back. Keep them at least as long as automatic retries run (about 43 hours over ten
attempts); an admin's retry can come later, up to the 90-day delivery retention. Record the id in
the same transaction as the work it triggers, so a crash cannot leave one without the other.
`createWebhookVerifier` does not deduplicate.
