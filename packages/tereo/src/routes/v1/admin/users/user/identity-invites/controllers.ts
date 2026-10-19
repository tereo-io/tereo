import { logAuditTx } from "../../../../../../utils/outbox.js";
import { validateUser } from "../../../../../../utils/auth.js";
import { CreateIdentityInviteSchema } from "./schemas.js";
import db from "../../../../../../utils/db/index.js";
import { UserIdParamSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../../../../utils/errors.js";
import {
  assertMayResetCredentials,
  assertNotServiceAccount,
  assertNotSystemUser,
} from "../guards.js";

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export const createIdentityInvite = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(UserIdParamSchema, req);
  const { providerId } = validateBody(CreateIdentityInviteSchema, req);
  assertNotSystemUser(id);

  const user = await db.users.get(id);
  await assertNotServiceAccount(user);

  const invite = await db.$transaction(async (tx) => {
    // An invite is a new way into the account, as a password reset is.
    await assertMayResetCredentials(auth, id, tx);
    const provider = await db.identityProviders.get(providerId).catch((err) => {
      if (err instanceof NotFoundError) {
        throw new BadRequestError(
          "unknown_provider",
          `Unknown identity provider: ${providerId}`
        );
      }
      throw err;
    });
    if (!provider.isActive) {
      throw new BadRequestError(
        "provider_inactive",
        "The identity provider is deactivated"
      );
    }
    if (await db.userIdentities.getForUserAtProvider(id, provider.id)) {
      throw new ConflictError(
        "The user is already linked to this provider",
        "already_linked"
      );
    }
    const issued = await db.userIdentities.upsertInvite(
      {
        userId: id,
        providerId: provider.id,
        createdBy: auth.userId,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
      tx
    );
    await logAuditTx(tx, {
      auth,
      action: "CREATE",
      entityType: "IdentityInvite",
      entityId: issued.id,
      entityName: user.email,
      metadata: {
        userId: id,
        providerId: provider.id,
        provider: provider.slug,
        expiresAt: issued.expiresAt.toISOString(),
      },
    });
    return issued;
  });

  res.status(201).json({
    providerId: invite.providerId,
    expiresAt: invite.expiresAt.toISOString(),
  });
};
