import { z } from "zod";

export const DomainIdParamSchema = z.object({
  id: z.guid(),
  domainId: z.guid(),
});
