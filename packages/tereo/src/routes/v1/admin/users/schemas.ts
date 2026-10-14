import { createCursorQuerySchema } from "../../../../utils/parseQueryString.js";
import { emailSchema } from "../../../../utils/email.js";
import { z } from "zod";

export const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(256, "Password must be at most 256 characters")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[0-9]/, "Password must contain at least one number")
  .regex(
    /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/,
    "Password must contain at least one special character"
  );

export const CreateUserSchema = z.object({
  email: emailSchema,
  // Omitted for a user who signs in only through an identity provider.
  password: passwordSchema.optional(),
  name: z.string().max(100).optional(),
  // Service accounts come with their service, from POST /admin/services.
  userType: z.literal("human").default("human"),
});

export type CreateUserInput = z.infer<typeof CreateUserSchema>;

const MAX_USER_IDS_PER_LOOKUP = 100;

export const ListUsersQuerySchema = createCursorQuerySchema({
  filters: {
    // A page of users by id, for resolving the actors a response names.
    id: {
      operators: ["equals", "in"],
      schema: z.string().uuid(),
      maxInValues: MAX_USER_IDS_PER_LOOKUP,
    },
    // Stored emails are lower case.
    email: {
      operators: ["contains", "equals"],
      schema: z.string().trim().toLowerCase(),
    },
    name: {
      operators: ["contains", "equals"],
      schema: z.string(),
    },
    isActive: {
      operators: ["equals"],
      schema: z.boolean(),
    },
    createdAt: {
      operators: ["gte", "lte"],
      schema: z.coerce.date(),
    },
  },
  sortFields: {
    id: "id",
    email: "email",
    name: "name",
    createdAt: "createdAt",
    isActive: "isActive",
  },
  nullableSortFields: ["name"],
  defaultSort: "id",
});
