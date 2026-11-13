import { z } from "zod";

export const groupGetQuerySchema = z.object({
  excludedAttributes: z.string().optional(),
});

export const groupIdParamSchema = z.object({ id: z.string() });
