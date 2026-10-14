import { emailSchema } from "../../../../../utils/email.js";
import { passwordSchema } from "../schemas.js";
import { z } from "zod";

export const UpdateUserSchema = z.object({
  email: emailSchema.optional(),
  password: passwordSchema.optional(),
  name: z.string().max(100).optional(),
  isActive: z.boolean().optional(),
});

export const UserIdParamSchema = z.object({
  id: z.guid(),
});

export const SetUserRolesSchema = z.object({
  roleIds: z.array(z.guid()).max(100),
});

export const RevokeSessionSchema = z.object({
  sessionId: z.guid(),
});

// prefault: a DELETE sent without a body leaves req.body undefined.
export const RevokeAllSessionsSchema = z
  .object({
    includeCurrentSession: z.boolean().optional().default(false),
  })
  .prefault({});

export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
export type SetUserRolesInput = z.infer<typeof SetUserRolesSchema>;
export type RevokeSessionInput = z.infer<typeof RevokeSessionSchema>;
