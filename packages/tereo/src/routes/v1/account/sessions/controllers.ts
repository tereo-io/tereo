import { recordSessionsRevoked } from "../../../../utils/sessionEvents.js";
import { validateBody } from "../../../../utils/validateReq.js";
import { endUserSessions } from "../../../../utils/sessions.js";
import { validateUser } from "../../../../utils/auth.js";
import { RevokeAllSessionsSchema } from "./schemas.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";

export const getSessions = async (req: Request, res: Response) => {
  const user = validateUser(req);

  const refreshTokens = await db.refreshTokens.getActiveByUserId(user.userId);

  res.json({
    sessions: refreshTokens.map((rt) => ({
      id: rt.id,
      clientId: rt.client.clientId,
      clientName: rt.client.name,
      scopes: rt.scopes,
      createdAt: rt.createdAt.toISOString(),
      expiresAt: rt.expiresAt.toISOString(),
      isCurrent: rt.id === user.currentSessionId,
    })),
  });
};
export const revokeAllSessions = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(RevokeAllSessionsSchema, req);

  const revoked = await endUserSessions(
    auth.userId,
    body.includeCurrentSession ? null : auth,
    recordSessionsRevoked(
      auth,
      { id: auth.userId, email: auth.email },
      { self: true }
    )
  );

  res.json({
    revokedCount: revoked.length,
    currentSessionRevoked:
      auth.currentSessionId !== null && revoked.includes(auth.currentSessionId),
  });
};
