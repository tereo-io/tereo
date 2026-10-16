import { validateUser, type AuthContext } from "../../../../middleware/auth.js";
import { ForbiddenError, BadRequestError } from "../../../../utils/errors.js";
import { assertEmitScope } from "../../../../middleware/organizationId.js";
import { PERMISSIONS } from "../../../../definitions/permissions.js";
import { emitEventSchema, batchEmitEventSchema } from "./schemas.js";
import { CORE_SERVICE_ID } from "../../../../definitions/index.js";
import { hasPermission } from "../../../../utils/permissions.js";
import { validateBody } from "../../../../utils/validateReq.js";
import { prisma } from "../../../../utils/db/prisma.js";
import db from "../../../../utils/db/index.js";
import { Request, Response } from "express";
import {
  assertNoReservedEventTypes,
  emitBatchWithIdempotency,
  emitWithIdempotency,
} from "../../../../utils/processEvent.js";

/**
 * Who may emit which event types over HTTP:
 * - core's own (`auth.*`, `file-service.*`, `core.service.*`): nobody — core
 *   emits them in-process, so one arriving here is forged;
 * - a registered service: only the event types it declares;
 * - an integration: none, as it declares nothing;
 * - any other caller: only with `webhooks.admin`, which may emit any
 *   service's event types.
 * Unregistered event types pass here and are refused with a 400 later.
 */
const assertMayEmit = async (auth: AuthContext, eventTypes: string[]) => {
  const owners = await prisma.eventType.findMany({
    where: { eventType: { in: [...new Set(eventTypes)] } },
    select: { eventType: true, serviceId: true },
  });

  const coreOwned = owners.filter((e) => e.serviceId === CORE_SERVICE_ID);
  if (coreOwned.length > 0) {
    throw new ForbiddenError(
      `Core's own event types are emitted only by core: ${coreOwned
        .map((e) => e.eventType)
        .join(", ")}`
    );
  }

  const service = auth.oauthClientId
    ? await db.services.getByClientId(auth.oauthClientId)
    : null;
  if (service?.kind === "integration") {
    throw new ForbiddenError(`Integration ${service.slug} can't emit events`);
  }
  if (service) {
    const foreign = owners.filter((e) => e.serviceId !== service.id);
    if (foreign.length > 0) {
      throw new ForbiddenError(
        `Service ${service.slug} may only emit event types it declares: ${foreign
          .map((e) => e.eventType)
          .join(", ")}`
      );
    }
    return;
  }

  if (!hasPermission(auth.permissions, PERMISSIONS.WEBHOOKS.ADMIN)) {
    throw new ForbiddenError(
      "Only the service that declares an event type, or webhooks.admin, may emit it"
    );
  }
};

/** Every organization named must exist; archived ones still count. */
const assertOrganizationsExist = async (organizationIds: string[]) => {
  const ids = [...new Set(organizationIds)];
  const found = await prisma.organization.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  const known = new Set(found.map((o) => o.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new BadRequestError(
      "unknown_organization",
      `No organization with id: ${missing.join(", ")}`
    );
  }
};

export const emitEvent = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(emitEventSchema, req);
  assertNoReservedEventTypes([body.eventType]);
  assertEmitScope(auth, [body.organizationId]);
  await assertOrganizationsExist([body.organizationId]);
  await assertMayEmit(auth, [body.eventType]);
  const processResult = await emitWithIdempotency(body, auth.userId);
  res.status(202).json({ deliveriesCreated: processResult.deliveriesCreated });
};

export const batchEmitEvents = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(batchEmitEventSchema, req);
  const eventTypes = body.events.map((e) => e.eventType);
  const organizationIds = body.events.map((e) => e.organizationId);
  assertNoReservedEventTypes(eventTypes);
  assertEmitScope(auth, organizationIds);
  await assertOrganizationsExist(organizationIds);
  await assertMayEmit(auth, eventTypes);
  const results = await emitBatchWithIdempotency(body.events, auth.userId);
  res.status(202).json({ results });
};
