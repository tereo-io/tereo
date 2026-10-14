import { z } from "zod";

export const NotificationIdParamsSchema = z.object({ id: z.guid() });
