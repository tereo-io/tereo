import { createCursorQuerySchema } from "../../../../utils/parseQueryString.js";
import { z } from "zod";

export const CreateOrganizationSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "Slug must start with a letter or number and contain only lowercase letters, numbers, and hyphens"
    ),
  code: z
    .string()
    .min(1)
    .max(6)
    .regex(/^[A-Z0-9]+$/, "Code must be uppercase alphanumeric (A-Z, 0-9)"),
});

export const OrgIdParamSchema = z.object({
  id: z.guid(),
});

export type CreateOrganizationInput = z.infer<typeof CreateOrganizationSchema>;

export const ListOrganizationsQuerySchema = createCursorQuerySchema({
  filters: {
    name: {
      operators: ["contains", "equals"],
      schema: z.string(),
    },
    slug: {
      operators: ["contains", "equals"],
      schema: z.string(),
    },
    code: {
      operators: ["contains", "equals"],
      schema: z.string(),
    },
    isActive: {
      operators: ["equals"],
      schema: z.boolean(),
    },
  },
  sortFields: {
    id: "id",
    name: "name",
    slug: "slug",
    createdAt: "createdAt",
    isActive: "isActive",
  },
  defaultSort: "id",
});

export const listOrganizationsExtraQuerySchema = z.object({
  // Strict parse: z.coerce.boolean() would treat "false" as true.
  includeArchived: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((v) => v === "true"),
});
