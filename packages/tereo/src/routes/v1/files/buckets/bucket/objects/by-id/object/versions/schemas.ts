import { createCursorQuerySchema } from "../../../../../../../../../utils/parseQueryString.js";
import { bucketNameSchema } from "../../../../../schemas.js";
import { z } from "zod";

/** For `GET /versions` (list) — no versionId in the URL. */
export const byIdListVersionsParamsSchema = z.object({
  name: bucketNameSchema.shape.name,
  id: z.guid("id must be a UUID"),
});

export const listVersionsQuerySchema = createCursorQuerySchema({
  sortFields: {
    createdAt: "createdAt",
  },
  defaultSort: "createdAt",
  defaultDir: "desc",
  defaultLimit: 100,
  maxLimit: 1000,
});

export type ListVersionsQuery = z.infer<typeof listVersionsQuerySchema>;
