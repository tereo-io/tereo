import { z } from "zod";

export const tokenParamSchema = z.object({
  token: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[A-Za-z0-9_-]{3,64}$/, "Invalid share token format"),
});

// `/shared/:token/:filename`: the segment is cosmetic, only carried over to
// the unlock page.
export const shareFilenameParamSchema = z.object({
  filename: z.string().max(255).optional(),
});

// Optional: a share without a password unlocks without one. A password
// share's handler requires it.
export const unlockBodySchema = z
  .object({ password: z.string().min(1).max(128).optional() })
  .optional();

export type TokenParams = z.infer<typeof tokenParamSchema>;
export type UnlockBody = z.infer<typeof unlockBodySchema>;
