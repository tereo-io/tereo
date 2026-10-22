import { bucketNameSchema } from "../../../schemas.js";
import { z } from "zod";

// `z.guid()`, not `z.uuid()`: any hex UUID is a valid `auth.users.id` to
// Postgres, including ones without an RFC 9562 variant.
export const userIdParamSchema = z.object({
  name: bucketNameSchema.shape.name,
  userId: z.guid(),
});

export const revokePermissionQuerySchema = z.object({
  // Strict parse: z.coerce.boolean() would treat "false" as true.
  revokeShares: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((v) => v === "true"),
});

export type UserIdParams = z.infer<typeof userIdParamSchema>;
export type RevokePermissionQuery = z.infer<typeof revokePermissionQuerySchema>;
