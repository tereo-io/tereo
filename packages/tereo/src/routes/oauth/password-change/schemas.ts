import { passwordSchema } from "../../v1/admin/users/schemas.js";
import { z } from "zod";

export const PasswordChangeSchema = z.object({
  change_grant: z.string().min(1).max(128),
  password: passwordSchema,
});

export type PasswordChangeInput = z.infer<typeof PasswordChangeSchema>;
