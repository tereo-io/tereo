import { validateBody, validateQuery } from "../../../../utils/validateReq.js";
import { listResponse } from "../../../../utils/scim/mapping.js";
import { parseFilter } from "../../../../utils/scim/filter.js";
import { scimBaseUrl } from "../../../../utils/scim/url.js";
import { scimListQuerySchema } from "../schemas.js";
import type { Request, Response } from "express";
import { scimContext } from "../middleware.js";
import {
  ScimGroupBodySchema,
  toGroupInput,
  toScimGroup,
} from "../../../../utils/scim/groupMapping.js";
import {
  createScimGroup,
  listScimGroups,
} from "../../../../utils/scim/groups.js";

export const listGroups = async (req: Request, res: Response) => {
  const query = validateQuery(scimListQuerySchema, req);
  const filter = parseFilter(query.filter, "Group");
  const { views, total } = await listScimGroups(scimContext(req), {
    filter,
    startIndex: query.startIndex,
    count: query.count,
  });
  const baseUrl = scimBaseUrl();
  res.type("application/scim+json").send(
    JSON.stringify(
      listResponse(
        views.map((view) => toScimGroup(view, baseUrl)),
        total,
        query.startIndex
      )
    )
  );
};

export const createGroup = async (req: Request, res: Response) => {
  const body = validateBody(ScimGroupBodySchema, req);
  const view = await createScimGroup(scimContext(req), toGroupInput(body));
  const resource = toScimGroup(view, scimBaseUrl());
  const { location } = resource.meta as { location: string };
  res
    .status(201)
    .location(location)
    .type("application/scim+json")
    .send(JSON.stringify(resource));
};
