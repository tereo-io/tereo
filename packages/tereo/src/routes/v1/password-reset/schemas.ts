import { emailSchema } from "../../../utils/email.js";
import { z } from "zod";

export const RequestPasswordResetSchema = z.object({
  email: emailSchema,
  client_id: z.string().max(255).optional(),
});
