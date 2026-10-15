import { createCursorQuerySchema } from "../../../../utils/parseQueryString.js";
import { ClientType } from "../../../../../prisma/generated/client/index.js";
import { z } from "zod";
import {
  UNSAFE_REDIRECT_URI_MESSAGE,
  isSafeRedirectUri,
} from "../../../../utils/redirectUris.js";

// Login clients only. A machine identity (client_credentials) is a service,
// added under /admin/services.
export const GrantTypeEnum = z.enum(["authorization_code", "refresh_token"]);

export const ClientTypeEnum = z.nativeEnum(ClientType);

// The redirect URI columns hold up to 2048 characters (authorization codes).
export const UriSchema = z
  .string()
  .url()
  .max(2048)
  .refine(isSafeRedirectUri, { message: UNSAFE_REDIRECT_URI_MESSAGE });
export const ScopeSchema = z.string().min(1).max(100);

export const AudienceSchema = z.array(z.string().min(1).max(64)).max(100);

export const PUBLIC_CLIENT_ALLOWED_GRANTS = [
  "authorization_code",
  "refresh_token",
];

export const CreateClientSchema = z
  .object({
    name: z.string().min(1).max(100),
    clientType: ClientTypeEnum.default("confidential"),
    redirectUris: z.array(UriSchema).max(50).default([]),
    postLogoutRedirectUris: z.array(UriSchema).max(50).default([]),
    scopes: z.array(ScopeSchema).max(100).default([]),
    grantTypes: z.array(GrantTypeEnum).min(1),
    consentRequired: z.boolean().default(true),
    audience: AudienceSchema.default([]),
  })
  .refine(
    (data) => {
      if (data.clientType === "public") {
        return data.grantTypes.every((gt) =>
          PUBLIC_CLIENT_ALLOWED_GRANTS.includes(gt)
        );
      }
      return true;
    },
    {
      message:
        "Public clients can only use authorization_code and refresh_token grant types",
      path: ["grantTypes"],
    }
  )
  .refine(
    (data) => {
      if (data.clientType === "public" && data.redirectUris.length === 0) {
        return false;
      }
      return true;
    },
    {
      message: "Public clients must have at least one redirect URI",
      path: ["redirectUris"],
    }
  );

export const ClientIdParamSchema = z.object({
  id: z.guid(),
});

export type CreateClientInput = z.infer<typeof CreateClientSchema>;

export const ListClientsQuerySchema = createCursorQuerySchema({
  filters: {
    name: {
      operators: ["contains", "equals"],
      schema: z.string(),
    },
    clientId: {
      operators: ["contains", "equals"],
      schema: z.string(),
    },
    clientType: {
      operators: ["equals"],
      schema: ClientTypeEnum,
    },
    ownerId: {
      operators: ["equals"],
      schema: z.guid(),
    },
  },
  sortFields: {
    id: "id",
    name: "name",
    clientId: "clientId",
    clientType: "clientType",
    createdAt: "createdAt",
  },
  defaultSort: "id",
});
