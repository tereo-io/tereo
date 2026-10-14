import { createCursorQuerySchema } from "../../../../utils/parseQueryString.js";
import { z } from "zod";

export const CreateRoleSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^[a-zA-Z][a-zA-Z0-9_-]*$/,
      "Role name must start with a letter and contain only letters, numbers, underscores, and hyphens"
    ),
  displayName: z.string().min(1).max(255),
  description: z.string().max(500).optional(),
  requires2fa: z.boolean().optional().default(false),
});

export const RoleIdParamSchema = z.object({
  id: z.guid(),
});

export type CreateRoleInput = z.infer<typeof CreateRoleSchema>;

export const ListRolesQuerySchema = createCursorQuerySchema({
  filters: {
    name: {
      operators: ["contains", "equals"],
      schema: z.string(),
    },
    displayName: {
      operators: ["contains", "equals"],
      schema: z.string(),
    },
    isActive: {
      operators: ["equals"],
      schema: z.boolean(),
    },
    serviceId: {
      operators: ["equals"],
      schema: z.guid(),
    },
  },
  sortFields: {
    id: "id",
    name: "name",
    displayName: "displayName",
    createdAt: "createdAt",
    isActive: "isActive",
  },
  defaultSort: "id",
});

// Strict parse: z.coerce.boolean() would treat "false" as true.
const flag = z
  .enum(["true", "false"])
  .optional()
  .default("false")
  .transform((v) => v === "true");

export const listRolesExtraQuerySchema = z.object({
  includeArchived: flag,
  includeRetired: flag,
});

export const DuplicateRoleSchema = z.object({
  name: CreateRoleSchema.shape.name,
  displayName: z.string().min(1).max(255).optional(),
  description: z.string().max(500).optional(),
});
