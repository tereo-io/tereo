import { z } from "zod";

export const GrantsClientParamsSchema = z.object({ id: z.guid() });

export const AddGrantSchema = z.object({ userId: z.guid() }).strict();
