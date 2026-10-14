import { contentTypeSchema, metadataSchema } from "../objects/schemas.js";
import { objectParamsSchema } from "../objects/object/schemas.js";
import { bucketNameSchema } from "../../schemas.js";
import { z } from "zod";

export const initiateParamsSchema = z.object({
  name: bucketNameSchema.shape.name,
});

// Multipart initiation is a bucket-level route (`POST /buckets/:name/multipart`),
// so `objectKey` travels in the body rather than the URL. Keeping it out of the
// path eliminates the splat-vs-literal collision that key-addressed routes have
// to work around elsewhere, and puts every multipart route under one namespace.
export const initiateBodySchema = z.object({
  objectKey: objectParamsSchema.shape.objectKey,
  contentType: contentTypeSchema,
  expectedSize: z.coerce.bigint().positive().optional(),
  metadata: metadataSchema,
  tags: z.array(z.string().min(1).max(128)).max(50).optional(),
});

export type InitiateBody = z.infer<typeof initiateBodySchema>;
