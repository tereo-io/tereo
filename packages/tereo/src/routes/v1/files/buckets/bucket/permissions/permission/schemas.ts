import { z } from "zod";

// `z.guid()`, not `z.uuid()`: any hex UUID is a valid `auth.users.id` to
// Postgres, including ones without an RFC 9562 variant.
export const userIdParamSchema = z.object({
  name: z.string(),
  userId: z.guid(),
});

export type UserIdParams = z.infer<typeof userIdParamSchema>;
