import { AdminProfileBodySchema } from "../../../../../utils/branding/schema.js";
import { assertBrandingAdmin } from "../../../../../utils/branding/access.js";
import { invalidateBranding } from "../../../../../utils/branding/resolve.js";
import { profileView } from "../../../../../utils/branding/view.js";
import { validateBody } from "../../../../../utils/validateReq.js";
import { validateUser } from "../../../../../utils/auth.js";
import db from "../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  deleteProfileTx,
  resolveImageRefs,
  saveProfileTx,
} from "../../../../../utils/branding/write.js";

const ACCESS = { canEdit: true, canManageGrants: false };

export const getDefaultBranding = async (req: Request, res: Response) => {
  assertBrandingAdmin(validateUser(req));
  res.json(await profileView(null, ACCESS));
};

export const putDefaultBranding = async (req: Request, res: Response) => {
  const user = validateUser(req);
  assertBrandingAdmin(user);
  const values = await resolveImageRefs(
    validateBody(AdminProfileBodySchema, req)
  );
  await db.$transaction((tx) =>
    saveProfileTx(tx, { client: null }, values, user, null)
  );
  await invalidateBranding();
  res.json(await profileView(null, ACCESS));
};

export const deleteDefaultBranding = async (req: Request, res: Response) => {
  const user = validateUser(req);
  assertBrandingAdmin(user);
  await db.$transaction((tx) => deleteProfileTx(tx, { client: null }, user));
  await invalidateBranding();
  res.status(204).send();
};
