import { NAMESPACE_PATTERN } from "../registry.js";
import { z } from "zod";

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Lengths are the columns' (slug, namespace and client_id 64, name 100).
const Slug = z
  .string()
  .max(64)
  .regex(NAMESPACE_PATTERN, "must be lowercase words joined by hyphens");
const EnvName = z
  .string()
  .regex(ENV_NAME_PATTERN, "must be an environment variable name");
const Text = z.string().min(1, "must not be empty");
const Name = Text.max(100);
const ClientId = Text.max(64);

const ServiceEntry = z
  .object({
    slug: Slug,
    name: Name,
    namespace: Slug.optional(),
    clientId: ClientId.optional(),
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
    clientId: ClientId,
    name: Name,
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
