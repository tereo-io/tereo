import { createCursorQuerySchema } from "../../../../utils/parseQueryString.js";
import { pgText } from "../../../../utils/pgInput.js";
import { z } from "zod";

export const getEventTypesQuerySchema = createCursorQuerySchema({
  filters: {
    source: {
      operators: ["equals"],
      schema: pgText(),
    },
    eventType: {
      operators: ["contains"],
      schema: pgText(),
    },
    retired: {
      operators: ["equals"],
      schema: z.boolean(),
      toWhere: ({ equals }) => ({
        retiredAt: equals ? { not: null } : null,
      }),
    },
  },
  sortFields: {
    eventType: "eventType",
    createdAt: "createdAt",
  },
  defaultSort: "createdAt",
  defaultLimit: 50,
  maxLimit: 200,
  // EventType has no `id`: its name (`eventType`) is the primary key.
  tiebreaker: "eventType",
});
