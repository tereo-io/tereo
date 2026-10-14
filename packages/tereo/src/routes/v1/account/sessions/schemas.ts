import { z } from "zod";

// The body is optional; Express leaves `req.body` undefined without one.
export const RevokeAllSessionsSchema = z
  .object({ includeCurrentSession: z.boolean().default(false) })
  .default({ includeCurrentSession: false });
