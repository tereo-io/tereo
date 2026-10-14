import { z } from "zod";

export const objectParamsSchema = z.object({
  name: z.string(),
  objectKey: z
    .string()
    .min(1, "Object key is required")
    .max(1024, "Object key too long")
    .regex(
      /^[a-zA-Z0-9/_\-. ()[\]{}+=@#$!&',]+$/,
      "Object key contains invalid characters"
    )
    .refine((key) => !key.includes(".."), "Path traversal not allowed")
    .refine((key) => !key.startsWith("/"), "Object key cannot start with /")
    .refine((key) => !key.endsWith("/"), "Object key cannot end with /")
    .refine((key) => !key.includes("//"), {
      message: "Object key cannot contain consecutive slashes",
    }),
});

export const downloadQuerySchema = z.object({
  versionId: z.string().uuid().optional(),
  thumbnail: z.enum(["thumb", "small", "medium"]).optional(),
});

export type ObjectParams = z.infer<typeof objectParamsSchema>;
export type DownloadQuery = z.infer<typeof downloadQuerySchema>;
