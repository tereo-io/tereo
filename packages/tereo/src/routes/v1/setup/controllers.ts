import { completeSetup, isSetupComplete } from "../../../utils/setup.js";
import { setupFailure } from "../../../middleware/rateLimit.js";
import { validateBody } from "../../../utils/validateReq.js";
import { NotFoundError } from "../../../utils/errors.js";
import { CompleteSetupSchema } from "./schemas.js";
import type { Request, Response } from "express";

/** Whether the UI should show the setup screen. Public. */
export const getSetupStatus = async (_req: Request, res: Response) => {
  res.json({ setupComplete: await isSetupComplete() });
};

/**
 * Create the first admin and name the default organization, authorized by a
 * setup token from the log. 404 once setup is complete.
 */
export const postSetup = async (req: Request, res: Response) => {
  if (await isSetupComplete()) throw new NotFoundError("Not found");
  await setupFailure.check(req);

  const body = validateBody(CompleteSetupSchema, req);
  const { user, organization } = await completeSetup(body);
  await setupFailure.reset(req);
  res.status(201).json({
    user: { id: user.id, email: user.email, name: user.name },
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      code: organization.code,
    },
  });
};
