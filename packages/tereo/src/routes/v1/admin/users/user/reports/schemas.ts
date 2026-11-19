import { BooleanFlagSchema } from "../../../groups/schemas.js";
import { z } from "zod";

export const UserReportsQuerySchema = z.object({
  transitive: BooleanFlagSchema.optional(),
});
