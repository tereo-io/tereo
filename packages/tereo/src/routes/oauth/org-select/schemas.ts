import { z } from "zod";

export const OrgSelectGetSchema = z.object({
  session: z.string().min(1).max(128),
});

export const OrgSelectSubmitSchema = z.object({
  session_token: z.string().min(1).max(128),
  organization_id: z.guid(),
});
