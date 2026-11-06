import { z } from "zod";

// prefault: a POST sent without a body leaves req.body undefined.
export const IssuePasswordSetupLinkSchema = z
  .object({
    notify: z.boolean().default(false),
  })
  .prefault({});
