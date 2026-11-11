import { NotFoundError } from "../../../utils/errors.js";
import { scimBaseUrl } from "../../../utils/scim/url.js";
import type { Request, Response } from "express";
import {
  serviceProviderConfig,
  resourceTypes,
  schemas,
} from "../../../utils/scim/resources.js";

const send = (res: Response, body: unknown) => {
  res.type("application/scim+json").send(JSON.stringify(body));
};

export const getServiceProviderConfig = (_req: Request, res: Response) => {
  send(res, serviceProviderConfig(scimBaseUrl()));
};

export const getResourceTypes = (_req: Request, res: Response) => {
  send(res, resourceTypes(scimBaseUrl()));
};

export const getSchemas = (_req: Request, res: Response) => {
  send(res, schemas());
};

export const notFound = (_req: Request, _res: Response) => {
  throw new NotFoundError("Resource not found");
};
