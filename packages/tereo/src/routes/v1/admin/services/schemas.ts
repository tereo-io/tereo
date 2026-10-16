import { createCursorQuerySchema } from "../../../../utils/parseQueryString.js";
import { NAMESPACE_PATTERN } from "../../../../utils/registry.js";
import { z } from "zod";

const word = (what: string) =>
  z
    .string()
    .min(1)
    .max(64)
    .regex(
      NAMESPACE_PATTERN,
      `${what} must be lowercase words joined by hyphens`
    );

export const CreateServiceSchema = z.object({
  name: z.string().min(1).max(100),
  /** Defaults to the name, lowercased and hyphenated. */
  slug: word("Slug").optional(),
  /** Defaults to the slug without a trailing `-service`. Fixed once set. */
  namespace: word("Namespace").optional(),
});

export const ListServicesQuerySchema = createCursorQuerySchema({
  filters: {
    slug: { operators: ["contains", "equals"], schema: z.string() },
    name: { operators: ["contains", "equals"], schema: z.string() },
  },
  sortFields: {
    id: "id",
    slug: "slug",
    name: "name",
    createdAt: "createdAt",
  },
  defaultSort: "id",
});

export const ListServiceAccessQuerySchema = createCursorQuerySchema({
  filters: {
    status: {
      operators: ["equals", "in"],
      schema: z.enum(["approved", "revoked"]),
    },
    kind: {
      operators: ["equals", "in"],
      schema: z.enum(["role", "audience"]),
    },
    serviceId: { operators: ["equals"], schema: z.guid() },
    target: { operators: ["contains", "equals"], schema: z.string() },
  },
  sortFields: {
    id: "id",
    requestedAt: "requestedAt",
  },
  defaultSort: "requestedAt",
});
