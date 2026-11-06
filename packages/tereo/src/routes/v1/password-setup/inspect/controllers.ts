import { passwordSetupFailure } from "../../../../middleware/rateLimit.js";
import { validateBody } from "../../../../utils/validateReq.js";
import { InspectPasswordSetupSchema } from "../schemas.js";
import { findUsableSetupToken } from "../controllers.js";
import type { Request, Response } from "express";

/** Who a setup link is for, so the page can greet them. Consumes nothing. */
export const inspectPasswordSetup = async (req: Request, res: Response) => {
  const { token } = validateBody(InspectPasswordSetupSchema, req);
  await passwordSetupFailure.assertUnderLimit(req);
  const { user } = await findUsableSetupToken(req, token);
  res.json({ email: user.email, name: user.name });
};
