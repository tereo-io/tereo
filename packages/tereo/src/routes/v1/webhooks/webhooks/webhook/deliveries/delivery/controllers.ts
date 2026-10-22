import { enqueueCommittedDelivery } from "../../../../../../../jobs/webhookQueues.js";
import { webhookScope } from "../../../../../../../utils/webhookOwnership.js";
import { validateParams } from "../../../../../../../utils/validateReq.js";
import { validateUser } from "../../../../../../../middleware/auth.js";
import { logAuditTx } from "../../../../../../../utils/outbox.js";
import { assertRetryableEndpoint } from "../controllers.js";
import { webhookDeliveryIdParamSchema } from "./schemas.js";
import db from "../../../../../../../utils/db/index.js";
import { Request, Response } from "express";
import {
  assertNotManagedByIntegration,
  getVisibleEndpoint,
  isFileEvent,
  mayResendFileEvents,
  redactUnreadable,
} from "../../../../../../../utils/webhookAccess.js";
import {
  BadRequestError,
  ArchivedError,
  ForbiddenError,
} from "../../../../../../../utils/errors.js";

export const getDelivery = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const scope = webhookScope(req);
  const { id, deliveryId } = validateParams(webhookDeliveryIdParamSchema, req);

  await getVisibleEndpoint(id, auth, scope);

  // Scope the delivery to this endpoint so a caller can't read another
  // endpoint's (or org's) delivery by pairing their own endpoint id with an
  // arbitrary deliveryId.
  const delivery = await db.webhookDeliveries.getForEndpoint(deliveryId, id);

  const [shown] = await redactUnreadable(auth, scope, [delivery]);
  res.json(shown);
};

export const retryDelivery = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const scope = webhookScope(req);
  const { organizationId } = scope;
  const { id, deliveryId } = validateParams(webhookDeliveryIdParamSchema, req);

  const endpoint = await getVisibleEndpoint(id, auth, scope);
  assertNotManagedByIntegration(endpoint, scope);
  if (endpoint.archivedAt) {
    throw new ArchivedError(
      "Webhook endpoint is archived; restore it before retrying deliveries"
    );
  }
  assertRetryableEndpoint(endpoint.status);

  const { createdAt, eventType } = await db.webhookDeliveries.getForEndpoint(
    deliveryId,
    id
  );
  if (isFileEvent(eventType) && !mayResendFileEvents(auth, endpoint)) {
    throw new ForbiddenError(
      "Only the endpoint's creator or webhooks.admin may retry its file-service deliveries"
    );
  }
  const ref = { id: deliveryId, createdAt };

  const updated = await db.$transaction(async (tx) => {
    const reset = await db.webhookDeliveries.resetForRetry(ref, id, tx);
    if (!reset) {
      throw new BadRequestError(
        "invalid_delivery_status",
        "Only FAILED deliveries can be retried"
      );
    }
    await logAuditTx(tx, {
      auth,
      organizationId,
      action: "UPDATE",
      entityType: "WebhookDelivery",
      entityId: deliveryId,
      metadata: { action: "retry", webhookEndpointId: id },
    });
    return reset;
  });

  await enqueueCommittedDelivery(ref);

  const [shown] = await redactUnreadable(auth, scope, [updated]);
  res.status(202).json(shown);
};
