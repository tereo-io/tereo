import { expiresAtSchema } from "../schemas.js";
import env from "../../../../../env.js";
import { z } from "zod";

export const GuestIdParamSchema = z.object({
  id: z.guid(),
});

// An expiry in the past is allowed: it ends the guest's access now.
export const UpdateGuestSchema = z.object({
  expiresAt: expiresAtSchema.refine(
    (d) => d.getTime() <= Date.now() + env.GUEST_MAX_TTL_SECONDS * 1000,
    {
      message: "A guest's expiry may be at most GUEST_MAX_TTL_SECONDS away",
    }
  ),
  name: z.string().max(100).optional(),
});
