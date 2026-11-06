import { issuePasswordSetupLink } from "../../../../../../utils/passwordSetup.js";
import { validateUser } from "../../../../../../utils/auth.js";
import { getGuest } from "../../../../../../utils/guests.js";
import { IssuePasswordSetupLinkSchema } from "./schemas.js";
import db from "../../../../../../utils/db/index.js";
import { GuestIdParamSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";

export const issueGuestPasswordSetupLink = async (
  req: Request,
  res: Response
) => {
  const auth = validateUser(req);
  const { id } = validateParams(GuestIdParamSchema, req);
  const { notify } = validateBody(IssuePasswordSetupLinkSchema, req);

  const { url, expiresAt } = await db.$transaction(async (tx) => {
    await getGuest(id, tx);
    return issuePasswordSetupLink(tx, {
      userId: id,
      createdBy: auth.userId,
      notify,
    });
  });
  res.json({ url, expiresAt: expiresAt.toISOString() });
};
