import { z } from "zod";

export const AssetParamsSchema = z.object({
  file: z.string().regex(/^[0-9a-f]{64}\.(png|jpg|webp|svg|ico)$/),
});
