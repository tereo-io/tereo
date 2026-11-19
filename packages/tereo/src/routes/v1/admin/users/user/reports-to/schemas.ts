import { z } from "zod";

export const SetReportsToSchema = z.object({ userId: z.guid() });
