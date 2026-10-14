import { z } from "zod";

export const AddMemberSchema = z.object({
  userId: z.guid(),
  memberRole: z.enum(["owner", "admin", "member"]).default("member"),
});

export type AddMemberInput = z.infer<typeof AddMemberSchema>;
