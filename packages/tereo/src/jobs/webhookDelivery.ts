import { openEndpointSecrets } from "../utils/webhookSecrets.js";
import { signatureHeader } from "../utils/webhookSigning.js";
import { SYSTEM_USER_ID } from "../definitions/index.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { logAuditTx } from "../utils/outbox.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";
import { Worker, Job } from "bullmq";
import type { Agent } from "undici";
import {
  BlockedAddressError,
  UnresolvableHostError,
  assertExternalTargetSafe,
  type PrivateHostOption,
} from "../utils/ssrfGuard.js";
import {
  isLastDeliveryAttempt,
  WEBHOOK_DELIVERY_ATTEMPTS,
  type WebhookDeliveryJobData,
} from "./webhookQueues.js";

let webhookDeliveryWorker: Worker | null = null;

/** Covers connecting, sending and reading the response. */
const DELIVERY_TIMEOUT_MS = 30_000;
/** How much of a receiver's response body is kept (`response_body` is 4096). */
export const MAX_RESPONSE_BODY_BYTES = 4096;
/** Exhausted deliveries in a row that disable an ACTIVE endpoint. */
export const AUTO_DISABLE_THRESHOLD = 5;

/** The attempt's error when the endpoint's signing secret cannot be opened. */
export const SECRET_UNAVAILABLE = "Signing secret cannot be opened";

/**
 * Resolves and checks a URL's host; returns a dispatcher pinned to it.
 * `allowPrivateHost` is the owning service's internalHost (ssrfGuard).
 */
export type ConnectTarget = (
  url: string,
  opts?: PrivateHostOption
) => Promise<Agent>;

type AttemptOutcome =
  | { ok: true; httpStatus: number; responseBody: string | null }
  | {
      ok: false;
      httpStatus: number | null;
      responseBody: string | null;
      errorMessage: string;
    };

/**
 * The first MAX_RESPONSE_BODY_BYTES of a response body, decoded leniently and
 * without NUL characters, which Postgres text cannot hold. The rest is never
 * read, so an endless or huge body costs nothing.
 */
async function readBodyPrefix(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_RESPONSE_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    // A body cut off by the timeout keeps what arrived.
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BODY_BYTES);
  return new TextDecoder().decode(bytes).replaceAll("\u0000", "");
}

/** What a failed attempt records: a category, never the underlying detail. */
const deliveryErrorMessage = (err: unknown): string => {
  if (err instanceof BlockedAddressError) {
    return "Target resolves to a private or reserved address";
  }
  if (err instanceof UnresolvableHostError) {
    return "Target host could not be resolved";
  }
  if (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  ) {
    return "Request timed out";
  }
  return "Connection failed";
};

const hostForLog = (url: string): string | undefined => {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
};

async function attemptDelivery(
  url: string,
  headers: Record<string, string>,
  body: string,
  connectTarget: ConnectTarget,
  targetOpts: PrivateHostOption
): Promise<AttemptOutcome> {
  // Bare fetch is intentional here. request-handler is built for known,
  // pre-registered upstreams with rate limits and OAuth/Basic auth. Customer
  // webhook URLs are arbitrary external endpoints — no client to register,
  // no shared rate limit, HMAC-signed (not Bearer-authed). BullMQ retry at
  // the job layer is the right place for retry on these endpoints.
  //
  // SSRF guard: every target is resolved, checked, and fetched through a
  // dispatcher pinned to the validated IPs (see ssrfGuard); redirects are
  // never followed, so a 3xx is a failed attempt.
  let dispatcher: Agent | undefined;
  try {
    const signal = AbortSignal.timeout(DELIVERY_TIMEOUT_MS);
    dispatcher = await connectTarget(url, targetOpts);
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal,
      redirect: "manual",
      // Not in the global fetch RequestInit type, but undici-backed fetch honors
      // it — this is what pins the connection to the validated IPs.
      dispatcher,
    } as RequestInit & { dispatcher?: Agent });
    const responseBody = await readBodyPrefix(response);
    if (response.ok) {
      return { ok: true, httpStatus: response.status, responseBody };
    }
    return {
      ok: false,
      httpStatus: response.status,
      responseBody,
      errorMessage: `HTTP ${response.status}`,
    };
  } catch (err) {
    // The detail (the addresses a host resolved to, resolver errors) stays in
    // the log: the delivery's message is shown to whoever manages the
    // endpoint, and must not map the internal network for them.
    logger.warn(
      { err, host: hostForLog(url) },
      "Webhook delivery attempt failed"
    );
    return {
      ok: false,
      httpStatus: null,
      responseBody: null,
      errorMessage: deliveryErrorMessage(err),
    };
  } finally {
    await dispatcher?.close().catch(() => {});
  }
}

/**
 * One delivery attempt. Throws to have BullMQ retry; returns once the delivery
 * is settled (SUCCESS, or FAILED on the last attempt or an inactive endpoint).
 * The last attempt is counted on the delivery, not the job: a job the stale
 * sweep re-queues starts a fresh BullMQ budget, but the delivery's total stays
 * within WEBHOOK_DELIVERY_ATTEMPTS.
 * `connectTarget` is replaceable for tests, which deliver to a local server.
 */
export async function processWebhookDelivery(
  job: Pick<Job<WebhookDeliveryJobData>, "data">,
  {
    connectTarget = assertExternalTargetSafe,
  }: { connectTarget?: ConnectTarget } = {}
): Promise<void> {
  const { deliveryId } = job.data;

  const delivery = await db.webhookDeliveries.findById(
    deliveryId,
    job.data.createdAt ? new Date(job.data.createdAt) : undefined
  );
  // Gone with its partition, or settled already: a second job for the same
  // delivery (a retry racing a pending job) must not send it again.
  if (!delivery || delivery.status !== "PENDING") {
    logger.debug(
      { deliveryId, status: delivery?.status ?? null },
      "Skipping webhook delivery that is not pending"
    );
    return;
  }
  const ref = { id: delivery.id, createdAt: delivery.createdAt };
  // Every write is conditional on the row still being as read here; one
  // that does not apply means another job got there first, and its side
  // effects are that job's.
  const write = (
    data: Parameters<typeof db.webhookDeliveries.updateAttempt>[1]
  ) => db.webhookDeliveries.updateIfUnchanged(ref, delivery.attempts, data);

  const endpoint = await db.webhookEndpoints.getById(
    delivery.webhookEndpointId
  );

  // Spent by earlier jobs whose last attempt never settled the row (a crash
  // between the send and the update): it still counts as one exhausted
  // delivery against the endpoint, unless core could not sign it.
  if (delivery.attempts >= WEBHOOK_DELIVERY_ATTEMPTS) {
    const settled = await write({
      attempts: delivery.attempts,
      lastAttemptAt: delivery.lastAttemptAt ?? new Date(),
      status: "FAILED",
      completedAt: new Date(),
    });
    if (
      settled &&
      endpoint.status === "ACTIVE" &&
      !endpoint.archivedAt &&
      delivery.errorMessage !== SECRET_UNAVAILABLE
    ) {
      await handleFinalFailure(endpoint.id);
    }
    return;
  }

  // A delivery may have been enqueued before the endpoint was paused,
  // disabled or archived.
  if (endpoint.status !== "ACTIVE" || endpoint.archivedAt) {
    await write({
      attempts: delivery.attempts + 1,
      lastAttemptAt: new Date(),
      status: "FAILED",
      errorMessage: endpoint.archivedAt
        ? "Endpoint is archived"
        : `Endpoint status is ${endpoint.status}`,
      completedAt: new Date(),
    });
    return;
  }

  const payloadJson = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);

  // A secret that cannot be opened (sealed under a KEK this process lacks, or
  // corrupt) fails the attempt like an unreachable receiver, so the delivery
  // spends its budget and settles instead of retrying without a record.
  let secrets: Awaited<ReturnType<typeof openEndpointSecrets>> | null = null;
  try {
    secrets = await openEndpointSecrets(endpoint);
  } catch (err) {
    logger.error(
      { err, deliveryId, endpointId: endpoint.id },
      "Webhook signing secret cannot be opened"
    );
  }

  const outcome: AttemptOutcome = secrets
    ? await attemptDelivery(
        endpoint.url,
        // Set after the custom headers so those cannot override them.
        {
          ...((endpoint.customHeaders as Record<string, string>) ?? {}),
          "Content-Type": "application/json",
          "X-Webhook-Id": deliveryId,
          "X-Webhook-Event": delivery.eventType,
          "X-Webhook-Timestamp": String(timestamp),
          "X-Webhook-Signature": signatureHeader(
            secrets,
            timestamp,
            payloadJson
          ),
        },
        payloadJson,
        connectTarget,
        // Only an endpoint a service owns may reach that service's own
        // internalHost; API-made endpoints keep the full guard.
        { allowPrivateHost: endpoint.ownerService?.internalHost ?? undefined }
      )
    : {
        ok: false,
        httpStatus: null,
        responseBody: null,
        errorMessage: SECRET_UNAVAILABLE,
      };

  if (outcome.ok) {
    const applied = await write({
      attempts: delivery.attempts + 1,
      lastAttemptAt: new Date(),
      httpStatus: outcome.httpStatus,
      responseBody: outcome.responseBody,
      errorMessage: null,
      status: "SUCCESS",
      completedAt: new Date(),
    });
    if (applied) {
      await db.webhookEndpoints.resetConsecutiveFailures(endpoint.id);
    }
    return;
  }

  const attempt = {
    attempts: delivery.attempts + 1,
    lastAttemptAt: new Date(),
    httpStatus: outcome.httpStatus,
    responseBody: outcome.responseBody,
    errorMessage: outcome.errorMessage,
  };
  if (isLastDeliveryAttempt(delivery.attempts)) {
    const settled = await write({
      ...attempt,
      status: "FAILED",
      completedAt: new Date(),
    });
    // A secret core cannot open is core's fault, not the receiver's: the
    // delivery fails, but it does not count toward auto-disabling.
    if (settled && outcome.errorMessage !== SECRET_UNAVAILABLE) {
      await handleFinalFailure(endpoint.id);
    }
    return;
  }
  const recorded = await write({
    ...attempt,
    status: "PENDING",
    completedAt: null,
  });
  if (!recorded) {
    logger.debug(
      { deliveryId },
      "Webhook delivery changed during the attempt; leaving it to that job"
    );
    return;
  }
  throw new Error(`Webhook delivery failed: ${outcome.errorMessage}`);
}

async function handleFinalFailure(endpointId: string): Promise<void> {
  const updated =
    await db.webhookEndpoints.incrementConsecutiveFailures(endpointId);
  if (updated.consecutiveFailures < AUTO_DISABLE_THRESHOLD) return;

  const disabled = await db.$transaction(async (tx) => {
    if (!(await db.webhookEndpoints.deactivate(endpointId, tx))) return false;
    await logAuditTx(tx, {
      auth: { userId: SYSTEM_USER_ID, email: null },
      organizationId: updated.organizationId,
      action: "UPDATE",
      entityType: "WebhookEndpoint",
      entityId: endpointId,
      changes: { status: { old: "ACTIVE", new: "DISABLED" } },
      metadata: {
        actor: "webhook-delivery-worker",
        reason: "auto-disabled",
        consecutiveFailures: updated.consecutiveFailures,
      },
    });
    return true;
  });
  if (disabled) {
    logger.warn(
      { endpointId, consecutiveFailures: updated.consecutiveFailures },
      "Webhook endpoint auto-disabled after repeated failures"
    );
  }
}

export async function startWebhookDeliveryWorker(): Promise<void> {
  const redis = getRedisClient();

  webhookDeliveryWorker = new TrackedWorker<WebhookDeliveryJobData>(
    "webhooks-delivery",
    async (job) => await processWebhookDelivery(job),
    { connection: redis.duplicate(), concurrency: 20 }
  );

  webhookDeliveryWorker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        deliveryId: (job?.data as WebhookDeliveryJobData)?.deliveryId,
        err,
      },
      "Webhook delivery job failed"
    );
  });

  webhookDeliveryWorker.on("completed", (job) => {
    logger.debug(
      {
        jobId: job?.id,
        deliveryId: (job?.data as WebhookDeliveryJobData)?.deliveryId,
      },
      "Webhook delivery job completed"
    );
  });

  logger.info("Webhook delivery worker started");
}

export async function stopWebhookDeliveryWorker(): Promise<void> {
  if (webhookDeliveryWorker) {
    await webhookDeliveryWorker.close();
    webhookDeliveryWorker = null;
  }
}
