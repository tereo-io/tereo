import { z } from "zod";

export const GroupSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9-]{1,100}$/,
    "Slug must be 1-100 lowercase letters, digits or hyphens"
  );
export const GroupNameSchema = z.string().min(1).max(255);
export const GroupDescriptionSchema = z.string().max(500).nullable();

export const ListLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(100)
  .default(50);

// Strict parse: z.coerce.boolean() would treat "false" as true.
export const BooleanFlagSchema = z
  .enum(["true", "false"])
  .transform((v) => v === "true");

export const ListGroupsQuerySchema = z.object({
  organizationId: z.union([z.literal("global"), z.guid()]).optional(),
  definitionSource: z.enum(["local", "provisioned"]).optional(),
  archived: BooleanFlagSchema.optional(),
  q: z.string().min(1).max(255).optional(),
  cursor: z.string().min(1).optional(),
  limit: ListLimitSchema,
});

/** Read before the rest of the body: who may create depends on it. */
export const CreateGroupScopeSchema = z.object({
  organizationId: z.guid().nullish(),
});

export const CreateGroupSchema = z.object({
  organizationId: z.guid().nullish(),
  slug: GroupSlugSchema,
  name: GroupNameSchema,
  description: GroupDescriptionSchema.optional(),
  roleIds: z.array(z.guid()).max(100).optional(),
});

export type ListGroupsQuery = z.infer<typeof ListGroupsQuerySchema>;
export type CreateGroupBody = z.infer<typeof CreateGroupSchema>;
