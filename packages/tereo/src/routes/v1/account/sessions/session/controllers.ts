import { recordSessionsRevoked } from "../../../../../utils/sessionEvents.js";
import { validateParams } from "../../../../../utils/validateReq.js";
import { NotFoundError } from "../../../../../utils/errors.js";
import { endSession } from "../../../../../utils/sessions.js";
import { validateUser } from "../../../../../utils/auth.js";
import { RevokeSessionSchema } from "./schemas.js";
import db from "../../../../../utils/db/index.js";
import type { Request, Response } from "express";

export const revokeSession = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { sessionId } = validateParams(RevokeSessionSchema, req);

  const session = await db.refreshTokens.getActiveForUser(
    sessionId,
    auth.userId
  );
  if (!session) throw new NotFoundError("Session not found");

  await endSession(
    sessionId,
    recordSessionsRevoked(
      auth,
      { id: auth.userId, email: auth.email },
      { self: true }
    )
  );

  res.status(204).send();
};
