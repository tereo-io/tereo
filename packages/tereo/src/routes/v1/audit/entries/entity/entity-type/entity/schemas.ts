import { createCursorQuerySchema } from "../../../../../../../utils/parseQueryString.js";
import { pgText as text } from "../../../../../../../utils/pgInput.js";
import { entryFilters } from "../../../schemas.js";
import { z } from "zod";

export const entityParamsSchema = z.object({
  entityType: text().min(1).max(100),
  entityId: text().min(1).max(500),
});

const {
  source,
  organizationId,
  userId,
  writerUserId,
  userEmail,
  action,
  createdAt,
} = entryFilters;

export const entityQuerySchema = createCursorQuerySchema({
  filters: {
    source,
    organizationId,
    userId,
    writerUserId,
    userEmail,
    action,
    createdAt,
  },
  sortFields: { createdAt: "createdAt" },
  defaultSort: "createdAt",
  defaultLimit: 50,
  maxLimit: 1000,
});
