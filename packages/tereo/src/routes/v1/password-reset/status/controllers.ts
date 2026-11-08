import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";

/** Whether resets can be sent, so the sign-in page knows to offer one. */
export const getPasswordResetStatus = async (_req: Request, res: Response) => {
  const connection = await db.notificationConnections.getDefault("email");
  res.json({ enabled: connection !== null });
};
