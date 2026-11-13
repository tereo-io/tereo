import { normaliseGroupPatch } from "../../../../../utils/scim/groupPatch.js";
import { ScimPatchBodySchema } from "../../../../../utils/scim/patch.js";
import { groupGetQuerySchema, groupIdParamSchema } from "../schemas.js";
import { scimBaseUrl } from "../../../../../utils/scim/url.js";
import { scimContext } from "../../middleware.js";
import type { Request, Response } from "express";
import {
  ScimGroupBodySchema,
  toGroupInput,
  toScimGroup,
} from "../../../../../utils/scim/groupMapping.js";
import {
  validateBody,
  validateParams,
  validateQuery,
} from "../../../../../utils/validateReq.js";
import {
  deleteScimGroup,
  getScimGroup,
  patchScimGroup,
  replaceScimGroup,
} from "../../../../../utils/scim/groups.js";

const excludesMembers = (excluded: string | undefined): boolean =>
  (excluded ?? "")
    .split(",")
    .some((attr) => attr.trim().toLowerCase() === "members");

export const getGroup = async (req: Request, res: Response) => {
  const query = validateQuery(groupGetQuerySchema, req);
  const view = await getScimGroup(
    scimContext(req),
    validateParams(groupIdParamSchema, req).id,
    {
      members: !excludesMembers(query.excludedAttributes),
    }
  );
  res
    .type("application/scim+json")
    .send(JSON.stringify(toScimGroup(view, scimBaseUrl())));
};

const send = (res: Response, view: Parameters<typeof toScimGroup>[0]) => {
  res
    .type("application/scim+json")
    .send(JSON.stringify(toScimGroup(view, scimBaseUrl())));
};

export const replaceGroup = async (req: Request, res: Response) => {
  const id = validateParams(groupIdParamSchema, req).id;
  const input = toGroupInput(validateBody(ScimGroupBodySchema, req));
  send(res, await replaceScimGroup(scimContext(req), id, input));
};

export const patchGroup = async (req: Request, res: Response) => {
  const id = validateParams(groupIdParamSchema, req).id;
  const ops = normaliseGroupPatch(validateBody(ScimPatchBodySchema, req));
  send(res, await patchScimGroup(scimContext(req), id, ops));
};

export const deleteGroup = async (req: Request, res: Response) => {
  await deleteScimGroup(
    scimContext(req),
    validateParams(groupIdParamSchema, req).id
  );
  res.status(204).send();
};
