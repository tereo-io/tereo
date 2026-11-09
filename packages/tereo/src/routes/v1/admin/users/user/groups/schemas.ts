import { BooleanFlagSchema } from "../../../groups/schemas.js";
import { z } from "zod";

export const UserGroupsQuerySchema = z.object({
  includeArchived: BooleanFlagSchema.optional(),
});
