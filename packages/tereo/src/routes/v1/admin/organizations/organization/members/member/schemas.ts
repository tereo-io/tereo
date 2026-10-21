import { z } from "zod";

export const MemberUserIdParamSchema = z.object({
  userId: z.guid(),
});

export const UpdateMemberRoleSchema = z.object({
  memberRole: z.enum(["owner", "admin", "member"]),
});

export const RemoveMemberQuerySchema = z.object({
  // Strict parse: z.coerce.boolean() would treat "false" as true.
  revokeShares: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((v) => v === "true"),
});

export type UpdateMemberRoleInput = z.infer<typeof UpdateMemberRoleSchema>;
