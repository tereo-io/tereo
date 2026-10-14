import { CreateIdentityProviderSchema } from "../schemas.js";
import { z } from "zod";

export const IdentityProviderIdParamSchema = z.object({
  id: z.guid(),
});

export const UpdateIdentityProviderSchema =
  CreateIdentityProviderSchema.partial();

export type UpdateIdentityProviderInput = z.infer<
  typeof UpdateIdentityProviderSchema
>;
