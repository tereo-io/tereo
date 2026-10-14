import { z } from "zod";

export const MemberUserIdParamSchema = z.object({
  userId: z.guid(),
});

export const UpdateMemberRoleSchema = z.object({
  memberRole: z.enum(["owner", "admin", "member"]),
});

export type UpdateMemberRoleInput = z.infer<typeof UpdateMemberRoleSchema>;
