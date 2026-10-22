import { assertSafeWebhookUrlForRegistration } from "../../../../utils/ssrfGuard.js";
import { validateBody, validateQuery } from "../../../../utils/validateReq.js";
import { assertNoReservedEventTypes } from "../../../../utils/processEvent.js";
import { resolveMaskedHeaders } from "../../../../utils/webhookHeaders.js";
import { formatWebhookEndpoint } from "../../../../utils/transformers.js";
import { assertMaySubscribe } from "../../../../utils/webhookAccess.js";
import { webhookScope } from "../../../../utils/webhookOwnership.js";
import { PERMISSIONS } from "../../../../definitions/permissions.js";
import { hasPermission } from "../../../../utils/permissions.js";
import { validateUser } from "../../../../middleware/auth.js";
import { BadRequestError } from "../../../../utils/errors.js";
import { logAuditTx } from "../../../../utils/outbox.js";
import db from "../../../../utils/db/index.js";
import { Request, Response } from "express";
import {
  emitEndpointEventTx,
  redactWebhookUrl,
} from "../../../../utils/webhookEndpointEvents.js";
import {
  applyCursorToWhere,
  buildCursorPageResponse,
} from "../../../../utils/cursor.js";
import {
  createWebhookEndpointSchema,
  getWebhookEndpointsQuerySchema,
  listWebhookEndpointsExtraQuerySchema,
} from "./schemas.js";

export const listWebhookEndpoints = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { organizationId, owner } = webhookScope(req);

  const query = validateQuery(getWebhookEndpointsQuerySchema, req);
  const { includeArchived, archivedFiltered } = validateQuery(
    listWebhookEndpointsExtraQuerySchema,
    req
  );

  // As getVisibleEndpoint shows them: an integration's own; otherwise the
  // organization's, with owned endpoints sent every organization's events
  // and integrations' endpoints only for webhooks.admin.
  const visible = owner
    ? { ownerServiceId: owner.id }
    : hasPermission(auth.permissions, PERMISSIONS.WEBHOOKS.ADMIN)
      ? { OR: [{ organizationId }, { organizationId: null }] }
      : {
          organizationId,
          OR: [
            { ownerServiceId: null },
            { ownerService: { is: { kind: "service" as const } } },
          ],
        };
  const where = applyCursorToWhere(query, {
    ...visible,
    ...(includeArchived || archivedFiltered ? {} : { archivedAt: null }),
  });

  const result = await db.webhookEndpoints.getPaginated({
    take: query.limit,
    orderBy: query.orderBy,
    where,
  });

  const withDeliveries = await db.webhookDeliveries.endpointsWithDeliveries(
    result.data.map((ep) => ep.id)
  );
  const data = result.data.map((ep) =>
    formatWebhookEndpoint(ep, { hasDeliveries: withDeliveries.has(ep.id) })
  );

  res.json(buildCursorPageResponse({ data, hasMore: result.hasMore }, query));
};

export const createWebhookEndpoint = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { organizationId, owner } = webhookScope(req);

  const body = validateBody(createWebhookEndpointSchema, req);

  // SSRF guard: reject internal/private/non-http(s) targets for tenant-registered
  // endpoints (registry-seeded internal subscriptions bypass this via the DB layer).
  assertSafeWebhookUrlForRegistration(body.url);

  // Nothing is stored yet, so the mask can stand for no value: refused.
  const customHeaders =
    body.customHeaders && resolveMaskedHeaders(body.customHeaders, null);

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
  assertMaySubscribe(auth.permissions, registered);

  const { endpoint, signingSecret } = await db.$transaction(async (tx) => {
    const created = await db.webhookEndpoints.create(
      {
        organizationId,
        createdBy: auth.userId,
        ownerServiceId: owner?.id ?? null,
        url: body.url,
        description: body.description,
        eventTypes: body.eventTypes,
        customHeaders,
      },
      tx
    );
    await logAuditTx(tx, {
      auth,
      organizationId,
      action: "CREATE",
      entityType: "WebhookEndpoint",
      entityId: created.endpoint.id,
      metadata: {
        url: redactWebhookUrl(body.url),
        eventTypes: body.eventTypes,
      },
    });
    await emitEndpointEventTx(tx, "created", created.endpoint);
    return created;
  });

  res.status(201).json(
    formatWebhookEndpoint(endpoint, {
      hasDeliveries: false,
      revealSecret: signingSecret,
    })
  );
};
