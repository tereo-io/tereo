import { validateParams } from "../../../../../utils/validateReq.js";
import { eventTypeParamSchema } from "./schemas.js";
import db from "../../../../../utils/db/index.js";
import { Request, Response } from "express";

export const getEventType = async (req: Request, res: Response) => {
  const { eventType } = validateParams(eventTypeParamSchema, req);

  const et = await db.eventTypes.getByEventType(eventType);

  res.json(et);
};
