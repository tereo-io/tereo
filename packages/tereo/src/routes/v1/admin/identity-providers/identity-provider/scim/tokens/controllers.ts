import { getDefaultOrganizationId } from "../../../../../../../utils/defaultOrganization.js";
import { validateParams } from "../../../../../../../utils/validateReq.js";
import { logAuditTx } from "../../../../../../../utils/outbox.js";
import { validateUser } from "../../../../../../../utils/auth.js";
import { IdentityProviderIdParamSchema } from "../../schemas.js";
import db from "../../../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  assertMayGrantScim,
  mintToken,
} from "../../../../../../../utils/scim/tokens.js";
import {
  ConflictError,
  NotFoundError,
} from "../../../../../../../utils/errors.js";

export const MAX_LIVE_TOKENS = 2;

export const createScimToken = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id: providerId } = validateParams(IdentityProviderIdParamSchema, req);
  const connection = await db.scim.getConnectionByProvider(providerId);
  if (!connection) throw new NotFoundError("SCIM connection not found");

  const { token, hash } = mintToken();
  const created = await db.$transaction(async (tx) => {
    await assertMayGrantScim(auth, tx);
    await db.scim.lockConnection(connection.id, tx);
    const live = (await db.scim.listTokens(connection.id, tx)).filter(
      (t) => t.revokedAt === null
    );
    if (live.length >= MAX_LIVE_TOKENS) {
      throw new ConflictError(
        `A connection holds at most ${MAX_LIVE_TOKENS} live tokens; revoke one first`,
        "scim_token_limit"
      );
    }
    const row = await db.scim.createToken(
      { connectionId: connection.id, hash, createdBy: auth.userId },
      tx
    );
    await logAuditTx(tx, {
      auth,
      organizationId: getDefaultOrganizationId(),
      action: "CREATE",
      entityType: "ScimToken",
      entityId: row.id,
      entityName: "SCIM token",
      metadata: { providerId, connectionId: connection.id },
    });
    return row;
  });

  res.status(201).json({ id: created.id, token, createdAt: created.createdAt });
};
