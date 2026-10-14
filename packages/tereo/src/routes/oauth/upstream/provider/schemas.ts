import { SlugSchema } from "../../../../utils/identityProviders/slug.js";
import { AuthorizeRequestSchema } from "../../authorize/schemas.js";
import { z } from "zod";

export const UpstreamProviderParamsSchema = z.object({
  slug: SlugSchema,
});

export const UpstreamStartQuerySchema = AuthorizeRequestSchema;

// The link-required page's start: the grant carries the authorize request.
export const UpstreamStartGrantQuerySchema = z.object({
  grant: z.string().min(1).max(128),
});

// A malformed state is a failed callback like any other, not a 400.
export const UpstreamCallbackQuerySchema = z.object({
  state: z.string().optional().catch(undefined),
});
