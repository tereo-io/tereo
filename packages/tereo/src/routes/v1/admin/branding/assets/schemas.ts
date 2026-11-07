import { BRANDING_IMAGE_SLOTS } from "../../../../../utils/branding/schema.js";
import { z } from "zod";

export const uploadAssetBodySchema = z.object({
  slot: z.enum(BRANDING_IMAGE_SLOTS),
});
