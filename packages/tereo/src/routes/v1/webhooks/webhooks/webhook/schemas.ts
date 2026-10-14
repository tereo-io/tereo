import { pgText } from "../../../../../utils/pgInput.js";
import { customHeadersSchema } from "../schemas.js";
import { z } from "zod";

export const webhookEndpointIdParamSchema = z.object({
  // Any 8-4-4-4-12 id, matching guardArchivedById's check.
  id: z.guid(),
});

export const updateWebhookEndpointSchema = z.object({
  url: pgText().url().max(2048).optional(),
  description: pgText().max(500).nullish(),
  eventTypes: z
    .array(pgText().max(100))
    .min(1, "At least one event type is required")
    .optional(),
  status: z.enum(["ACTIVE", "PAUSED"]).optional(),
  customHeaders: customHeadersSchema.nullish(),
});
