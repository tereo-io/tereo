import { validateOrganizationId } from "../../../../../../../middleware/organizationId.js";
import { enqueueCommittedDelivery } from "../../../../../../../jobs/webhookQueues.js";
import { validateParams } from "../../../../../../../utils/validateReq.js";
import { validateUser } from "../../../../../../../middleware/auth.js";
import { logAuditTx } from "../../../../../../../utils/outbox.js";
import { assertRetryableEndpoint } from "../controllers.js";
import { webhookDeliveryIdParamSchema } from "./schemas.js";
import db from "../../../../../../../utils/db/index.js";
import { Request, Response } from "express";
import {
  getVisibleEndpoint,
  redactUnreadable,
} from "../../../../../../../utils/webhookAccess.js";
import {
  BadRequestError,
  ArchivedError,
} from "../../../../../../../utils/errors.js";

export const getDelivery = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const organizationId = validateOrganizationId(req);
  const { id, deliveryId } = validateParams(webhookDeliveryIdParamSchema, req);

  await getVisibleEndpoint(id, auth, organizationId);

  // Scope the delivery to this endpoint so a caller can't read another
  // endpoint's (or org's) delivery by pairing their own endpoint id with an
  // arbitrary deliveryId.
  const delivery = await db.webhookDeliveries.getForEndpoint(deliveryId, id);

  const [shown] = await redactUnreadable(auth, organizationId, [delivery]);
  res.json(shown);
};

export const retryDelivery = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const organizationId = validateOrganizationId(req);
  const { id, deliveryId } = validateParams(webhookDeliveryIdParamSchema, req);

  const endpoint = await getVisibleEndpoint(id, auth, organizationId);
  if (endpoint.archivedAt) {
    throw new ArchivedError(
      "Webhook endpoint is archived; restore it before retrying deliveries"
    );
  }
  assertRetryableEndpoint(endpoint.status);

  const { createdAt } = await db.webhookDeliveries.getForEndpoint(
    deliveryId,
    id
  );
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

  const [shown] = await redactUnreadable(auth, organizationId, [updated]);
  res.status(202).json(shown);
};
