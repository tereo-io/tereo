import { assertSafeWebhookUrlForRegistration } from "../../../../../utils/ssrfGuard.js";
import { rethrowRestrictedAsConflict } from "../../../../../utils/prismaErrors.js";
import { assertNoReservedEventTypes } from "../../../../../utils/processEvent.js";
import { enqueueCommittedDelivery } from "../../../../../jobs/webhookQueues.js";
import { formatWebhookEndpoint } from "../../../../../utils/transformers.js";
import { logAuditTx, computeChanges } from "../../../../../utils/outbox.js";
import { webhookScope } from "../../../../../utils/webhookOwnership.js";
import { TEST_EVENT_TYPE } from "../../../../../definitions/index.js";
import { validateUser } from "../../../../../middleware/auth.js";
import db from "../../../../../utils/db/index.js";
import { Request, Response } from "express";
import env from "../../../../../env.js";
import {
  maskCustomHeaders,
  resolveMaskedHeaders,
} from "../../../../../utils/webhookHeaders.js";
import {
  assertMaySubscribe,
  assertNotManagedByIntegration,
  assertNotProvisioned,
  getVisibleEndpoint,
} from "../../../../../utils/webhookAccess.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";
import {
  AlreadyArchivedError,
  ArchivedError,
  BadRequestError,
  NotArchivedError,
  NotFoundError,
} from "../../../../../utils/errors.js";
import {
  webhookEndpointIdParamSchema,
  updateWebhookEndpointSchema,
} from "./schemas.js";

const withDeliveryFlag = async (
  endpoint: Awaited<ReturnType<typeof db.webhookEndpoints.getById>>,
  options: { revealSecret?: string } = {}
) => {
  const withDeliveries = await db.webhookDeliveries.endpointsWithDeliveries([
    endpoint.id,
  ]);
  return formatWebhookEndpoint(endpoint, {
    ...options,
    hasDeliveries: withDeliveries.has(endpoint.id),
  });
};

const withoutSecrets = ({
  signingSecret: _secret,
  signingSecretHint: _hint,
  previousSigningSecret: _previous,
  ...rest
}: Awaited<ReturnType<typeof db.webhookEndpoints.getById>>): Record<
  string,
  unknown
> => rest;

export const getWebhookEndpoint = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const scope = webhookScope(req);
  const { id } = validateParams(webhookEndpointIdParamSchema, req);

  const endpoint = await getVisibleEndpoint(id, auth, scope);

  res.json(await withDeliveryFlag(endpoint));
};

export const updateWebhookEndpoint = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const scope = webhookScope(req);
  const { organizationId } = scope;
  const { id } = validateParams(webhookEndpointIdParamSchema, req);
  const body = validateBody(updateWebhookEndpointSchema, req);

  const existing = await getVisibleEndpoint(id, auth, scope);
  // Archived-endpoint rejection is enforced by guardArchived on the PATCH route.
  // A provisioned endpoint takes only a status change: re-enabling one that
  // was disabled, which the file cannot do.
  const statusOnly = Object.entries(body).every(
    ([key, value]) => key === "status" || value === undefined
  );
  if (!statusOnly) {
    assertNotProvisioned(existing);
    assertNotManagedByIntegration(existing, scope);
  }
  // An admin pausing an integration's endpoint changes nothing it is sent.
  const adminPause =
    statusOnly && !scope.owner && existing.ownerService?.kind === "integration";

  // SSRF guard on URL changes (same rationale as create).
  if (body.url) {
    assertSafeWebhookUrlForRegistration(body.url);
  }

  if (body.eventTypes) {
    assertNoReservedEventTypes(body.eventTypes);
    const registered = await db.eventTypes.findMany(body.eventTypes);
    const registeredSet = new Set(registered.map((et) => et.eventType));
    const invalid = body.eventTypes.filter((et) => !registeredSet.has(et));
    if (invalid.length > 0) {
      throw new BadRequestError(
        "invalid_event_type",
        `The following event types are not registered or are retired: ${invalid.join(", ")}`
      );
    }
  }
  // The endpoint is sent what its creator may read; whoever changes where it
  // goes or what it carries must be able to read all of it too.
  if (!existing.provisioned && !adminPause) {
    assertMaySubscribe(
      auth.permissions,
      await db.eventTypes.findMany(body.eventTypes ?? existing.eventTypes)
    );
  }

  const updated = await db.$transaction(async (tx) => {
    // Masks resolve against the row as it is now: one read before this
    // transaction could write back a header value changed since.
    const current = await db.webhookEndpoints.getForUpdate(id, tx);
    if (current.archivedAt) {
      throw new ArchivedError("Webhook endpoint is archived");
    }
    const customHeaders = body.customHeaders
      ? resolveMaskedHeaders(body.customHeaders, current.customHeaders)
      : body.customHeaders;
    const result = await db.webhookEndpoints.update(
      id,
      { ...body, customHeaders },
      tx
    );
    // Compared on the real values, so a changed value is recorded, then masked.
    const changes = computeChanges(
      withoutSecrets(current),
      withoutSecrets(result)
    );
    if (changes?.customHeaders) {
      changes.customHeaders = {
        old: maskCustomHeaders(changes.customHeaders.old),
        new: maskCustomHeaders(changes.customHeaders.new),
      };
    }
    await logAuditTx(tx, {
      auth,
      organizationId,
      action: "UPDATE",
      entityType: "WebhookEndpoint",
      entityId: id,
      changes,
    });
    return result;
  });

  res.json(await withDeliveryFlag(updated));
};

export const archiveWebhookEndpoint = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const scope = webhookScope(req);
  const { organizationId } = scope;
  const { id } = validateParams(webhookEndpointIdParamSchema, req);

  const existing = await getVisibleEndpoint(id, auth, scope);
  assertNotProvisioned(existing);
  if (existing.archivedAt) {
    throw new AlreadyArchivedError("Webhook endpoint is already archived");
  }

  const updated = await db.$transaction(async (tx) => {
    const result = await db.webhookEndpoints.archive(id, tx);
    if (!result) throw new NotFoundError("Webhook endpoint not found");
    await logAuditTx(tx, {
      auth,
      organizationId,
      action: "ARCHIVE",
      entityType: "WebhookEndpoint",
      entityId: id,
    });
    return result;
  });

  res.json(await withDeliveryFlag(updated));
};

export const restoreWebhookEndpoint = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const scope = webhookScope(req);
  const { organizationId } = scope;
  const { id } = validateParams(webhookEndpointIdParamSchema, req);

  const existing = await getVisibleEndpoint(id, auth, scope);
  assertNotProvisioned(existing);
  if (!existing.archivedAt) {
    throw new NotArchivedError("Webhook endpoint is not archived");
  }

  const updated = await db.$transaction(async (tx) => {
    const result = await db.webhookEndpoints.restore(id, tx);
    if (!result) throw new NotFoundError("Webhook endpoint not found");
    await logAuditTx(tx, {
      auth,
      organizationId,
      action: "RESTORE",
      entityType: "WebhookEndpoint",
      entityId: id,
    });
    return result;
  });

  res.json(await withDeliveryFlag(updated));
};

export const deleteWebhookEndpoint = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const scope = webhookScope(req);
  const { organizationId } = scope;
  const { id } = validateParams(webhookEndpointIdParamSchema, req);

  const existing = await getVisibleEndpoint(id, auth, scope);
  assertNotProvisioned(existing);

  await db.$transaction(async (tx) => {
    try {
      await db.webhookEndpoints.remove(id, tx);
    } catch (err) {
      // Delivery history (ON DELETE RESTRICT) still references this endpoint —
      // surface a 409 until retention purges those rows.
      rethrowRestrictedAsConflict(
        err,
        "Webhook endpoint still has delivery history and cannot be deleted"
      );
      throw err;
    }
    await logAuditTx(tx, {
      auth,
      organizationId,
      action: "DELETE",
      entityType: "WebhookEndpoint",
      entityId: id,
      metadata: { url: existing.url },
    });
  });

  res.status(204).send();
};

export const rotateSecret = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const scope = webhookScope(req);
  const { organizationId } = scope;
  const { id } = validateParams(webhookEndpointIdParamSchema, req);

  const existing = await getVisibleEndpoint(id, auth, scope);
  assertNotProvisioned(existing);
  assertNotManagedByIntegration(existing, scope);
  // Archived-endpoint rejection is enforced by guardArchived on the rotate route.

  const overlapMs = env.WEBHOOK_SECRET_OVERLAP_HOURS * 60 * 60 * 1000;
  const previousSecretExpiresAt =
    overlapMs > 0 ? new Date(Date.now() + overlapMs) : null;

  const updated = await db.$transaction(async (tx) => {
    const result = await db.webhookEndpoints.rotateSecret(
      id,
      previousSecretExpiresAt,
      tx
    );
    await logAuditTx(tx, {
      auth,
      organizationId,
      action: "UPDATE",
      entityType: "WebhookEndpoint",
      entityId: id,
      metadata: { action: "rotate-secret", previousSecretExpiresAt },
    });
    return result;
  });

  res.json(
    await withDeliveryFlag(updated.endpoint, {
      revealSecret: updated.signingSecret,
    })
  );
};

export const revokePreviousSecret = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const scope = webhookScope(req);
  const { organizationId } = scope;
  const { id } = validateParams(webhookEndpointIdParamSchema, req);

  const existing = await getVisibleEndpoint(id, auth, scope);
  assertNotProvisioned(existing);
  assertNotManagedByIntegration(existing, scope);

  const updated = await db.$transaction(async (tx) => {
    const result = await db.webhookEndpoints.revokePreviousSecret(id, tx);
    await logAuditTx(tx, {
      auth,
      organizationId,
      action: "UPDATE",
      entityType: "WebhookEndpoint",
      entityId: id,
      metadata: { action: "revoke-previous-secret" },
    });
    return result;
  });

  res.json(await withDeliveryFlag(updated));
};

export const testWebhookEndpoint = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const scope = webhookScope(req);
  const { organizationId } = scope;
  const { id } = validateParams(webhookEndpointIdParamSchema, req);

  const endpoint = await getVisibleEndpoint(id, auth, scope);
  assertNotManagedByIntegration(endpoint, scope);
  // Archived-endpoint rejection is enforced by guardArchived on the test route.

  if (endpoint.status !== "ACTIVE") {
    throw new BadRequestError(
      "invalid_endpoint_status",
      "Only ACTIVE endpoints can be tested"
    );
  }

  const payload = {
    id: crypto.randomUUID(),
    eventType: TEST_EVENT_TYPE,
    entityType: "WebhookEndpoint",
    entityId: endpoint.id,
    occurredAt: new Date().toISOString(),
    data: {
      message: "This is a test webhook delivery",
      timestamp: new Date().toISOString(),
    },
  };

  const delivery = await db.$transaction(async (tx) => {
    const created = await db.webhookDeliveries.create(
      {
        webhookEndpointId: endpoint.id,
        eventType: TEST_EVENT_TYPE,
        payload,
      },
      tx
    );
    await logAuditTx(tx, {
      auth,
      organizationId,
      action: "CREATE",
      entityType: "WebhookDelivery",
      entityId: created.id,
      metadata: { action: "test", webhookEndpointId: endpoint.id },
    });
    return created;
  });

  await enqueueCommittedDelivery(delivery);

  res.status(202).json({ deliveryId: delivery.id });
};

export const getEndpointStats = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const scope = webhookScope(req);
  const { id } = validateParams(webhookEndpointIdParamSchema, req);

  await getVisibleEndpoint(id, auth, scope);

  const stats = await db.webhookDeliveries.getStats(id);
  res.json(stats);
};
