import { toScimUser } from "../../../../../utils/scim/mapping.js";
import { findVisible } from "../../../../../utils/scim/users.js";
import { scimBaseUrl } from "../../../../../utils/scim/url.js";
import { NotFoundError } from "../../../../../utils/errors.js";
import { scimContext } from "../../middleware.js";
import type { Request, Response } from "express";
import { userIdParamSchema } from "./schemas.js";

const notFound = () => new NotFoundError("User not found");

export const getUser = async (req: Request, res: Response) => {
  const params = userIdParamSchema.safeParse(req.params);
  if (!params.success) throw notFound();
  const found = await findVisible(
    scimContext(req),
    params.data.id.toLowerCase()
  );
  if (!found) throw notFound();
  res
    .type("application/scim+json")
    .send(JSON.stringify(toScimUser(found.user, found.link, scimBaseUrl())));
};
