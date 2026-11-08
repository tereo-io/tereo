import { getDefaultOrganizationId } from "../../../../../../../utils/defaultOrganization.js";
import { assertMayManageGrants } from "../../../../../../../utils/branding/access.js";
import { Prisma } from "../../../../../../../../prisma/generated/client/index.js";
import { emitTx, logAuditTx } from "../../../../../../../utils/outbox.js";
import { AddGrantSchema, GrantsClientParamsSchema } from "./schemas.js";
import { validateUser } from "../../../../../../../utils/auth.js";
import db from "../../../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../../utils/validateReq.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../../../../../utils/errors.js";

const loadClient = async (req: Request) => {
  const { id } = validateParams(GrantsClientParamsSchema, req);
  return await db.clients.get(id);
};

export const listGrants = async (req: Request, res: Response) => {
  const user = validateUser(req);
  const client = await loadClient(req);
  assertMayManageGrants(user, client);
  const grants = await db.brandingGrants.listActive(client.id);
  res.json({
    data: grants.map((g) => ({
      userId: g.userId,
      email: g.user.email,
      name: g.user.name,
      grantedBy: g.grantedBy,
      grantedAt: g.grantedAt.toISOString(),
    })),
  });
};

const alreadyGranted = () =>
  new ConflictError("This user already holds a grant on the client");

export const addGrant = async (req: Request, res: Response) => {
  const user = validateUser(req);
  const client = await loadClient(req);
  assertMayManageGrants(user, client);
  const { userId } = validateBody(AddGrantSchema, req);

  try {
    await db.$transaction(async (tx) => {
      const grantee = await db.users.get(userId, tx);
      if (!grantee.isActive) {
        throw new BadRequestError(
          "user_inactive",
          "Cannot grant branding to a deactivated user"
        );
      }
      if (await db.brandingGrants.getActive(client.id, userId, tx)) {
        throw alreadyGranted();
      }
      const grant = await db.brandingGrants.create(
        { clientUuid: client.id, userId, grantedBy: user.userId },
        tx
      );
      await logAuditTx(tx, {
        auth: user,
        action: "CREATE",
        entityType: "BrandingGrant",
        entityId: grant.id,
        entityName: client.clientId,
        metadata: { clientId: client.clientId, userId, email: grantee.email },
      });
      await emitTx(tx, {
        organizationId: getDefaultOrganizationId(),
        eventType: "auth.branding.grant-added",
        entityType: "BrandingGrant",
        entityId: grant.id,
        data: { clientId: client.clientId, userId, grantedBy: user.userId },
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      // A concurrent grant slipped past the check; the partial unique index holds.
      if (err.code === "P2002") throw alreadyGranted();
      // The client was deleted meanwhile; users never are.
      if (err.code === "P2003") throw new NotFoundError("Client not found");
    }
    throw err;
  }
  res.status(201).json({ userId });
};
