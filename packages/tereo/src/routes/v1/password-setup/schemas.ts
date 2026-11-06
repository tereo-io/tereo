import { passwordSchema } from "../admin/users/schemas.js";
import { z } from "zod";

export const InspectPasswordSetupSchema = z.object({
  token: z.string().min(1).max(128),
});

export const SetPasswordSchema = z.object({
  token: z.string().min(1).max(128),
  password: passwordSchema,
});
