import { z } from "zod";

export const signedArchiveParamsSchema = z.object({ id: z.guid() });
