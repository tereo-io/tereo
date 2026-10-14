import { SlugSchema } from "../../../../utils/identityProviders/slug.js";
import { z } from "zod";

export const RESERVED_SLUGS = ["providers"];

export const CreateIdentityProviderSchema = z.object({
  slug: SlugSchema,
  displayName: z.string().min(1).max(100),
  kind: z.literal("oidc"),
  issuer: z.url().max(512),
  clientId: z.string().min(1).max(255),
  clientSecret: z.string().min(1).max(4096),
  scopes: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
  countsAsMfa: z.boolean().optional(),
});

export type CreateIdentityProviderInput = z.infer<
  typeof CreateIdentityProviderSchema
>;
