import { formatAdminUser } from "../../../../../utils/transformers.js";
import { GuestIdParamSchema, UpdateGuestSchema } from "./schemas.js";
import { validateUser } from "../../../../../utils/auth.js";
import db from "../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";
import {
  getGuest as findGuest,
  guestOrganizationId,
  updateGuest as update,
} from "../../../../../utils/guests.js";

export const getGuest = async (req: Request, res: Response) => {
  const { id } = validateParams(GuestIdParamSchema, req);
  const user = await findGuest(id);
  res.json({
    ...formatAdminUser(user),
    organizationId: await guestOrganizationId(id),
  });
};

export const updateGuest = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(GuestIdParamSchema, req);
  const body = validateBody(UpdateGuestSchema, req);

  const user = await db.$transaction((tx) => update(tx, auth, id, body));
  res.json({
    ...formatAdminUser(user),
    organizationId: await guestOrganizationId(id),
  });
};
