import { listResponse, toScimUser } from "../../../../utils/scim/mapping.js";
import { validateQuery } from "../../../../utils/validateReq.js";
import { parseFilter } from "../../../../utils/scim/filter.js";
import { listVisible } from "../../../../utils/scim/users.js";
import { scimBaseUrl } from "../../../../utils/scim/url.js";
import { listUsersQuerySchema } from "./schemas.js";
import type { Request, Response } from "express";
import { scimContext } from "../middleware.js";

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
