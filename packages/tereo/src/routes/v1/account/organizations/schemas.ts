import { createCursorQuerySchema } from "../../../../utils/parseQueryString.js";
import { z } from "zod";

export const ListAccountOrganizationsQuerySchema = createCursorQuerySchema({
  sortFields: { name: "name", slug: "slug" },
  defaultSort: "name",
  defaultDir: "asc",
});

export const AccountOrganizationsSearchSchema = z.object({
  search: z.string().trim().min(2).max(100).optional(),
});
