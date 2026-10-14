import { createCursorQuerySchema } from "../../../../../../utils/parseQueryString.js";
import { z } from "zod";

export const grantPermissionSchema = z.object({
  userId: z.guid(),
  canRead: z.boolean().default(false),
  canWrite: z.boolean().default(false),
  canDelete: z.boolean().default(false),
});

export const listPermissionsQuerySchema = createCursorQuerySchema({
  filters: {
    userId: {
      operators: ["equals", "in"],
      schema: z.guid(),
    },
    canRead: {
      operators: ["equals"],
      schema: z.boolean(),
    },
    canWrite: {
      operators: ["equals"],
      schema: z.boolean(),
    },
    canDelete: {
      operators: ["equals"],
      schema: z.boolean(),
    },
  },
  sortFields: {
    userId: "userId",
    grantedAt: "grantedAt",
  },
  defaultSort: "grantedAt",
  defaultLimit: 100,
  maxLimit: 1000,
});

export type GrantPermissionInput = z.infer<typeof grantPermissionSchema>;
export type ListPermissionsQuery = z.infer<typeof listPermissionsQuerySchema>;
