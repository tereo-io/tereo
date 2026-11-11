import { validateBody } from "../../../../../utils/validateReq.js";
import { scimBaseUrl } from "../../../../../utils/scim/url.js";
import { NotFoundError } from "../../../../../utils/errors.js";
import { scimContext } from "../../middleware.js";
import type { Request, Response } from "express";
import { userIdParamSchema } from "./schemas.js";
import {
  ScimUserBodySchema,
  toScimUser,
  toUserInput,
} from "../../../../../utils/scim/mapping.js";
import {
  ScimPatchBodySchema,
  applyPatch,
} from "../../../../../utils/scim/patch.js";
import {
  findVisible,
  patchScimUser,
  replaceScimUser,
  type Visible,
} from "../../../../../utils/scim/users.js";

const notFound = () => new NotFoundError("User not found");

const userId = (req: Request): string => {
  const params = userIdParamSchema.safeParse(req.params);
  if (!params.success) throw notFound();
  return params.data.id.toLowerCase();
};

const send = (res: Response, { user, link }: Visible) => {
  res
    .type("application/scim+json")
    .send(JSON.stringify(toScimUser(user, link, scimBaseUrl())));
};

export const getUser = async (req: Request, res: Response) => {
  const found = await findVisible(scimContext(req), userId(req));
  if (!found) throw notFound();
  send(res, found);
};

export const replaceUser = async (req: Request, res: Response) => {
  const id = userId(req);
  const input = toUserInput(validateBody(ScimUserBodySchema, req));
  send(res, await replaceScimUser(scimContext(req), id, input));
};

export const patchUser = async (req: Request, res: Response) => {
  const id = userId(req);
  const input = applyPatch(validateBody(ScimPatchBodySchema, req));
  send(res, await patchScimUser(scimContext(req), id, input));
};
