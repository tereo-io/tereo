import { z } from "zod";

export const GroupsTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("global") }).strict(),
  z
    .object({ kind: z.literal("organization"), organizationId: z.guid() })
    .strict(),
]);

// `isActive` is required to create the connection; on an update, omitting it
// leaves the state as it is.
export const PutScimConnectionSchema = z
  .object({
    isActive: z.boolean().optional(),
    groupsTarget: GroupsTargetSchema.optional(),
  })
  .strict();

export type PutScimConnectionInput = z.infer<typeof PutScimConnectionSchema>;
