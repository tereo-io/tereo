import { z } from "zod";

// Anything that is not a usable client id counts as no client
// (`resolveBranding` decides), so the value is not narrowed here.
export const BrandingQuerySchema = z.object({
  client_id: z.unknown().optional(),
});
