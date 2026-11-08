import { AdminProfileBodySchema } from "../../../../../../utils/branding/schema.js";
import { z } from "zod";

export const BrandingClientParamsSchema = z.object({ id: z.guid() });

export const PutBrandingProfileSchema = AdminProfileBodySchema;
