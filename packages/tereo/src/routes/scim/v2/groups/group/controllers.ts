import { toScimGroup } from "../../../../../utils/scim/groupMapping.js";
import { groupGetQuerySchema, groupIdParamSchema } from "../schemas.js";
import { scimBaseUrl } from "../../../../../utils/scim/url.js";
import { scimContext } from "../../middleware.js";
import type { Request, Response } from "express";
import {
  validateParams,
  validateQuery,
} from "../../../../../utils/validateReq.js";
import {
  deleteScimGroup,
  getScimGroup,
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

export const deleteGroup = async (req: Request, res: Response) => {
  await deleteScimGroup(
    scimContext(req),
    validateParams(groupIdParamSchema, req).id
  );
  res.status(204).send();
};
