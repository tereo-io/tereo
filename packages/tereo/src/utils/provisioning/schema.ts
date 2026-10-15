import { NAMESPACE_PATTERN } from "../registry.js";
import { z } from "zod";

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const Slug = z
  .string()
  .regex(NAMESPACE_PATTERN, "must be lowercase words joined by hyphens");
const EnvName = z
  .string()
  .regex(ENV_NAME_PATTERN, "must be an environment variable name");
const Text = z.string().min(1, "must not be empty");

const ServiceEntry = z
  .object({
    slug: Slug,
    name: Text,
    namespace: Slug.optional(),
    clientId: Text.optional(),
    secretFrom: EnvName,
    access: z
      .object({
        roles: z.array(Text).default([]),
        audiences: z.array(Text).default([]),
      })
      .strict()
      .default({ roles: [], audiences: [] }),
  })
  .strict();

const ClientEntry = z
  .object({
    clientId: Text,
    name: Text,
    clientType: z.enum(["public", "confidential"]).default("public"),
    secretFrom: EnvName.optional(),
    redirectUris: z.array(Text).default([]),
    postLogoutRedirectUris: z.array(Text).default([]),
    scopes: z.array(Text).default([]),
    grantTypes: z
      .array(z.enum(["authorization_code", "refresh_token"]))
      .default(["authorization_code", "refresh_token"]),
    audience: z.array(Text).default([]),
    consentRequired: z.boolean().default(true),
  })
  .strict();

export const ProvisioningFileSchema = z
  .object({
    services: z.array(ServiceEntry).default([]),
    clients: z.array(ClientEntry).default([]),
  })
  .strict();
