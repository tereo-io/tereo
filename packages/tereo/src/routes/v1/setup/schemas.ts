import { CreateOrganizationSchema } from "../admin/organizations/schemas.js";
import { passwordSchema } from "../admin/users/schemas.js";
import { emailSchema } from "../../../utils/email.js";
import { z } from "zod";

export const CompleteSetupSchema = z.object({
  token: z.string().min(1).max(64),
  admin: z.object({
    email: emailSchema,
    name: z.string().min(1).max(100),
    password: passwordSchema,
  }),
  organization: CreateOrganizationSchema,
});
