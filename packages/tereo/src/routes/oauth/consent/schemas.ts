import { z } from "zod";

export const ConsentGetSchema = z.object({
  session: z.string().min(1).max(64),
});

export const ConsentSubmitSchema = z.object({
  session_token: z.string().min(1).max(64),
  approved: z
    .string()
    .transform((val) => val === "true")
    .or(z.boolean()),
});
