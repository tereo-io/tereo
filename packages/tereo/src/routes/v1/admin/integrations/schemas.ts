import { createCursorQuerySchema } from "../../../../utils/parseQueryString.js";
import { NAMESPACE_PATTERN } from "../../../../utils/registry.js";
import { z } from "zod";

export const CreateIntegrationSchema = z.object({
  name: z.string().min(1).max(100),
  /** Defaults to the name, lowercased and hyphenated. */
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(NAMESPACE_PATTERN, "Slug must be lowercase words joined by hyphens")
    .optional(),
  /** Org-bound when given; fixed once set. */
  organizationId: z.guid().optional(),
});

export const ListIntegrationsQuerySchema = createCursorQuerySchema({
  filters: {
    slug: { operators: ["contains", "equals"], schema: z.string() },
    name: { operators: ["contains", "equals"], schema: z.string() },
    organizationId: { operators: ["equals"], schema: z.guid() },
    isActive: { operators: ["equals"], schema: z.boolean() },
  },
  sortFields: {
    id: "id",
    slug: "slug",
    name: "name",
    createdAt: "createdAt",
  },
  defaultSort: "id",
});
