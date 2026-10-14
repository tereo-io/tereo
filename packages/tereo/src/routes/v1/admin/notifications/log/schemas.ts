import { createCursorQuerySchema } from "../../../../../utils/parseQueryString.js";
import { CHANNELS } from "../../../../../utils/notifications/channels/index.js";
import { pgDate, pgText } from "../../../../../utils/pgInput.js";
import { z } from "zod";

export const ListNotificationsQuerySchema = createCursorQuerySchema({
  filters: {
    channel: { operators: ["equals"], schema: z.enum(CHANNELS) },
    status: {
      operators: ["equals", "in"],
      schema: z.enum(["pending", "sent", "partial", "failed"]),
    },
    senderUserId: { operators: ["equals"], schema: z.guid() },
    // Addresses are stored lower-cased, so the match is case-insensitive.
    recipient: {
      operators: ["equals"],
      schema: pgText().min(1).max(320).toLowerCase(),
      toWhere: (clause) => ({
        deliveries: {
          some: {
            recipients: { array_contains: [{ address: clause.equals }] },
          },
        },
      }),
    },
    createdAt: { operators: ["gte", "lte"], schema: pgDate() },
  },
  sortFields: { createdAt: "createdAt" },
  defaultSort: "createdAt",
});
