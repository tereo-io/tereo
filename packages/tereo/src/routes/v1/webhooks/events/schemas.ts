import { pgJson, pgText } from "../../../../utils/pgInput.js";
import { z } from "zod";

export const emitEventSchema = z.object({
  // Any 8-4-4-4-12 id, as Postgres' uuid type takes it; z.uuid() would also
  // reject ids whose variant nibble is outside 8-b.
  organizationId: z.guid(),
  eventType: pgText().min(1).max(100),
  entityType: pgText().min(1).max(100),
  entityId: pgText().min(1),
  data: pgJson(z.record(z.string(), z.unknown())),
  idempotencyKey: pgText().min(1).max(255).optional(),
});

export const batchEmitEventSchema = z.object({
  events: z.array(emitEventSchema).min(1).max(100),
});
