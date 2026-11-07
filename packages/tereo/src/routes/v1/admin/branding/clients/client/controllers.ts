import { profileView } from "../../../../../../utils/branding/view.js";
import { ForbiddenError } from "../../../../../../utils/errors.js";
import { validateUser } from "../../../../../../utils/auth.js";
import db from "../../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  assertMayEditClientBranding,
  assertMayReadClientBranding,
  mayManageGrants,
  type BrandingUser,
} from "../../../../../../utils/branding/access.js";
import {
  deleteProfileTx,
  invalidateAfterWrite,
  resolveImageRefs,
  saveProfileTx,
} from "../../../../../../utils/branding/write.js";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";
import {
  BrandingClientParamsSchema,
  PutBrandingProfileSchema,
} from "./schemas.js";

const loadClient = async (req: Request) => {
  const { id } = validateParams(BrandingClientParamsSchema, req);
  return await db.clients.get(id);
};

const view = async (
  user: BrandingUser,
  client: Awaited<ReturnType<typeof loadClient>>
) => {
  let canEdit = true;
  try {
    await assertMayEditClientBranding(user, client);
  } catch (err) {
    if (!(err instanceof ForbiddenError)) throw err;
    canEdit = false;
  }
  return await profileView(client, {
    canEdit,
    canManageGrants: mayManageGrants(user, client),
  });
};

export const getClientBranding = async (req: Request, res: Response) => {
  const user = validateUser(req);
  const client = await loadClient(req);
  await assertMayReadClientBranding(user, client);
  res.json(await view(user, client));
};

export const putClientBranding = async (req: Request, res: Response) => {
  const user = validateUser(req);
  const client = await loadClient(req);
  await assertMayEditClientBranding(user, client);
  const values = await resolveImageRefs(
    validateBody(PutBrandingProfileSchema, req)
  );
  await db.$transaction((tx) =>
    saveProfileTx(tx, { client }, values, user, null)
  );
  await invalidateAfterWrite();
  res.json(await view(user, client));
};

export const deleteClientBranding = async (req: Request, res: Response) => {
  const user = validateUser(req);
  const client = await loadClient(req);
  await assertMayEditClientBranding(user, client);
  await db.$transaction((tx) => deleteProfileTx(tx, { client }, user));
  await invalidateAfterWrite();
  res.status(204).send();
};
