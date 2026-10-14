import { pgText } from "../../../../../utils/pgInput.js";
import { z } from "zod";

export const eventTypeParamSchema = z.object({
  eventType: pgText().min(1),
});
