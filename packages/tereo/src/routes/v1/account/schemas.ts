import { passwordSchema } from "../admin/users/schemas.js";
import { z } from "zod";

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  // Reuse the shared policy so self-service changes can't drop below the
  // strength required at account creation.
  newPassword: passwordSchema,
});
