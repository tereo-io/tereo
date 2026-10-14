import { createCursorQuerySchema } from "../../../../../../utils/parseQueryString.js";
import { pgDate, pgText } from "../../../../../../utils/pgInput.js";
import { z } from "zod";

export const webhookEndpointIdParamSchema = z.object({
  id: z.guid(),
});

export const getWebhookDeliveriesQuerySchema = createCursorQuerySchema({
  filters: {
    status: {
      operators: ["equals", "in"],
      schema: z.enum(["PENDING", "SUCCESS", "FAILED"]),
    },
    eventType: {
      operators: ["equals"],
      schema: pgText(),
    },
    createdAt: {
      operators: ["gte", "lte"],
      schema: pgDate(),
    },
  },
  sortFields: {
    createdAt: "createdAt",
  },
  defaultSort: "createdAt",
  defaultLimit: 25,
  maxLimit: 100,
});

export const bulkRetrySchema = z.object({
  createdAfter: pgDate().optional(),
  createdBefore: pgDate().optional(),
  eventType: pgText().max(100).optional(),
  limit: z.number().int().min(1).max(1000).default(100),
});
