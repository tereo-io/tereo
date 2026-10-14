import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";

export const listProviders = async (_req: Request, res: Response) => {
  const providers = await db.identityProviders.list({ activeOnly: true });
  res.json(providers.map(({ slug, displayName }) => ({ slug, displayName })));
};
