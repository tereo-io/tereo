import { validateBody } from "../../../utils/validateReq.js";
import { validateUser } from "../../../middleware/auth.js";
import { ForbiddenError } from "../../../utils/errors.js";
import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";
import {
  declarationSchema,
  registerDeclaration,
} from "../../../utils/registry.js";

export const postDeclaration = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(declarationSchema, req);

  // Only a service's own client-credentials token names a service.
  const service = auth.oauthClientId
    ? await db.services.getByClientId(auth.oauthClientId)
    : null;
  if (!service) {
    throw new ForbiddenError(
      "Only a service's client credentials can register a declaration"
    );
  }

  const result = await registerDeclaration(service, body, {
    userId: auth.userId,
    email: auth.email,
  });
  res.json({ service: service.slug, ...result });
};
