import { validateBody, validateQuery } from "../../../../utils/validateReq.js";
import { createScimUser, listVisible } from "../../../../utils/scim/users.js";
import { parseFilter } from "../../../../utils/scim/filter.js";
import { scimBaseUrl } from "../../../../utils/scim/url.js";
import { listUsersQuerySchema } from "./schemas.js";
import type { Request, Response } from "express";
import { scimContext } from "../middleware.js";
import {
  listResponse,
  ScimUserBodySchema,
  toScimUser,
  toUserInput,
} from "../../../../utils/scim/mapping.js";

export const listUsers = async (req: Request, res: Response) => {
  const query = validateQuery(listUsersQuerySchema, req);
  const filter = parseFilter(query.filter);
  const { items, total } = await listVisible(scimContext(req), filter, query);
  const baseUrl = scimBaseUrl();
  res.type("application/scim+json").send(
    JSON.stringify(
      listResponse(
        items.map(({ user, link }) => toScimUser(user, link, baseUrl)),
        total,
        query.startIndex
      )
    )
  );
};

export const createUser = async (req: Request, res: Response) => {
  const body = validateBody(ScimUserBodySchema, req);
  const { user, link } = await createScimUser(
    scimContext(req),
    toUserInput(body)
  );
  const resource = toScimUser(user, link, scimBaseUrl());
  const { location } = resource.meta as { location: string };
  res
    .status(201)
    .location(location)
    .type("application/scim+json")
    .send(JSON.stringify(resource));
};
