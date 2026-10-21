import { bucketNameSchema } from "../buckets/schemas.js";
import { z } from "zod";

// Shapes past "a string" are left to `presigning.verify`, which answers any
// malformed signature parameter with the same 403 as a wrong signature.
const required = z.string().min(1);
const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : null));

export const signedQuerySchema = z.object({
  expires: required,
  nonce: required,
  v: required,
  sig: required,
  share: optional,
  by: optional,
  version: optional,
  filename: z.string().max(255).optional(),
  disposition: z.string().optional(),
});

// A malformed id or bucket name names nothing a URL could be signed for, so
// `signedObjectParams` answers it as a wrong signature.
export const signedObjectParamsSchema = z.object({
  bucket: bucketNameSchema.shape.name,
  id: z.guid(),
});

export type SignedQuery = z.infer<typeof signedQuerySchema>;
