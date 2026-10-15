import { z } from "zod";
import {
  GrantTypeEnum,
  ClientTypeEnum,
  ScopeSchema,
  UriSchema,
} from "../schemas.js";

export const UpdateClientSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  clientType: ClientTypeEnum.optional(),
  redirectUris: z.array(UriSchema).max(50).optional(),
  postLogoutRedirectUris: z.array(UriSchema).max(50).optional(),
  scopes: z.array(ScopeSchema).max(100).optional(),
  grantTypes: z.array(GrantTypeEnum).min(1).optional(),
  ownerId: z.guid().optional(),
  consentRequired: z.boolean().optional(),
});

export type UpdateClientInput = z.infer<typeof UpdateClientSchema>;
