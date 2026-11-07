import { resolveBranding } from "../../../utils/branding/resolve.js";
import { validateQuery } from "../../../utils/validateReq.js";
import { BrandingQuerySchema } from "./schemas.js";
import type { Request, Response } from "express";

/** The same value the sign-in page's injected block carries, `null` when nothing resolves. */
export const getBranding = async (req: Request, res: Response) => {
  const { client_id } = validateQuery(BrandingQuerySchema, req);
  const branding = await resolveBranding(client_id);
  res.json(branding && { ...branding, scope: "auth" });
};
