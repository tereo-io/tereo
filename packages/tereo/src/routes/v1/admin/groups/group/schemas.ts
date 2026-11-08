import { z } from "zod";
import {
  GroupDescriptionSchema,
  GroupNameSchema,
  GroupSlugSchema,
} from "../schemas.js";

export const GroupIdParamSchema = z.object({
  id: z.guid(),
});

export const UpdateGroupSchema = z
  .object({
    slug: GroupSlugSchema.optional(),
    name: GroupNameSchema.optional(),
    description: GroupDescriptionSchema.optional(),
  })
  .refine(
    (body) =>
      body.slug !== undefined ||
      body.name !== undefined ||
      body.description !== undefined,
    { message: "Provide at least one of slug, name or description" }
  );

export type UpdateGroupBody = z.infer<typeof UpdateGroupSchema>;
