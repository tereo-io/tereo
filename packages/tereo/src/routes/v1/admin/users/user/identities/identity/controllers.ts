import { unlinkIdentity } from "../../../../../../../utils/identityProviders/identities.js";
import { validateParams } from "../../../../../../../utils/validateReq.js";
import { validateUser } from "../../../../../../../utils/auth.js";
import { assertMayResetCredentials } from "../../guards.js";
import { UserIdentityParamsSchema } from "./schemas.js";
import type { Request, Response } from "express";

export const unlinkUserIdentity = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id, identityId } = validateParams(UserIdentityParamsSchema, req);
  // Unlinking changes how the account is entered, as an identity invite does.
  await assertMayResetCredentials(auth, id);
  await unlinkIdentity(auth, id, identityId);
  res.status(204).send();
};
