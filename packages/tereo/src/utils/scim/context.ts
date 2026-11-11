import type { Request } from "express";
import type {
  IdentityProvider,
  ScimConnection,
} from "../../../prisma/generated/client/index.js";

export interface ScimContext {
  connection: ScimConnection;
  provider: IdentityProvider;
  tokenId: string;
}

export const setScimContext = (req: Request, context: ScimContext): void => {
  (req as Request & { scim?: ScimContext }).scim = context;
};

export const scimContext = (req: Request): ScimContext => {
  const context = (req as Request & { scim?: ScimContext }).scim;
  if (!context) throw new Error("SCIM context read before authentication");
  return context;
};
