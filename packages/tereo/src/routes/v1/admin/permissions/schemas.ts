import { createCursorQuerySchema } from "../../../../utils/parseQueryString.js";
import { z } from "zod";

export const ListPermissionsQuerySchema = createCursorQuerySchema({
  filters: {
    name: {
      operators: ["contains", "equals"],
      schema: z.string(),
    },
    displayName: {
      operators: ["contains", "equals"],
      schema: z.string(),
    },
    serviceId: {
      operators: ["equals"],
      schema: z.guid(),
    },
    orgAssignable: {
      operators: ["equals"],
      schema: z.boolean(),
    },
  },
  sortFields: {
    id: "id",
    name: "name",
    displayName: "displayName",
    createdAt: "createdAt",
  },
  defaultSort: "id",
});

export const listPermissionsExtraQuerySchema = z.object({
  // Strict parse: z.coerce.boolean() would treat "false" as true.
  includeRetired: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((v) => v === "true"),
});
