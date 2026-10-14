import { validateOrganizationId } from "../../../../../../middleware/organizationId.js";
import { enqueueCommittedDelivery } from "../../../../../../jobs/webhookQueues.js";
import { redactUnreadable } from "../../../../../../utils/webhookAccess.js";
import { validateUser } from "../../../../../../middleware/auth.js";
import { logAuditTx } from "../../../../../../utils/outbox.js";
import db from "../../../../../../utils/db/index.js";
import { Request, Response } from "express";
import {
  validateBody,
  validateParams,
  validateQuery,
} from "../../../../../../utils/validateReq.js";
import {
  NotFoundError,
  ArchivedError,
  BadRequestError,
} from "../../../../../../utils/errors.js";
import {
  applyCursorToWhere,
  buildCursorPageResponse,
} from "../../../../../../utils/cursor.js";
import {
  webhookEndpointIdParamSchema,
  getWebhookDeliveriesQuerySchema,
  bulkRetrySchema,
} from "./schemas.js";

export const listDeliveries = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const organizationId = validateOrganizationId(req);
  const { id } = validateParams(webhookEndpointIdParamSchema, req);
  const query = validateQuery(getWebhookDeliveriesQuerySchema, req);

  const endpoint = await db.webhookEndpoints.getById(id);
  if (endpoint.organizationId !== organizationId) {
    throw new NotFoundError("Webhook endpoint not found");
  }

  const where = applyCursorToWhere(query, { webhookEndpointId: id });

  const result = await db.webhookDeliveries.getPaginated({
    take: query.limit,
    orderBy: query.orderBy,
    where,
  });

  const data = await redactUnreadable(auth, organizationId, result.data);
  res.json(buildCursorPageResponse({ ...result, data }, query));
};

/**
 * 400 `invalid_endpoint_status` unless the endpoint is ACTIVE: the worker
 * fails a delivery to a PAUSED or DISABLED endpoint without sending it.
 */
export const assertRetryableEndpoint = (status: string): void => {
  if (status !== "ACTIVE") {
    throw new BadRequestError(
      "invalid_endpoint_status",
      "Deliveries can be retried only for an ACTIVE endpoint; re-enable it first"
    );
  }
};

export const bulkRetryDeliveries = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const organizationId = validateOrganizationId(req);
  const { id } = validateParams(webhookEndpointIdParamSchema, req);
  const body = validateBody(bulkRetrySchema, req);

  const endpoint = await db.webhookEndpoints.getById(id);
  if (endpoint.organizationId !== organizationId) {
    throw new NotFoundError("Webhook endpoint not found");
  }
  if (endpoint.archivedAt) {
    throw new ArchivedError(
      "Webhook endpoint is archived; restore it before retrying deliveries"
    );
  }
  assertRetryableEndpoint(endpoint.status);

  const reset = await db.$transaction(async (tx) => {
    const rows = await db.webhookDeliveries.bulkResetForRetry(id, body, tx);
    if (rows.length > 0) {
      await logAuditTx(tx, {
        auth,
        organizationId,
        action: "UPDATE",
        entityType: "WebhookEndpoint",
        entityId: id,
        metadata: {
          action: "retry-deliveries",
          retriedCount: rows.length,
          filters: body,
        },
      });
    }
    return rows;
  });

  for (const delivery of reset) await enqueueCommittedDelivery(delivery);

  res.status(202).json({ retriedCount: reset.length });
};
