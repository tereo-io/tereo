import { z } from "zod";

export const GroupsTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("global") }).strict(),
  z
    .object({ kind: z.literal("organization"), organizationId: z.guid() })
    .strict(),
]);

export const PutScimConnectionSchema = z.object({
  isActive: z.boolean(),
  groupsTarget: GroupsTargetSchema.optional(),
});

export type PutScimConnectionInput = z.infer<typeof PutScimConnectionSchema>;
