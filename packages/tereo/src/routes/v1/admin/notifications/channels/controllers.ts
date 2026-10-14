import type { Request, Response } from "express";
import { z } from "zod";
import {
  getAdapter,
  CHANNELS,
} from "../../../../../utils/notifications/channels/index.js";

/** The channels core can send through, with what a connection to each takes. */
export const listChannels = (_req: Request, res: Response) => {
  res.json({
    data: CHANNELS.map((channel) => {
      const adapter = getAdapter(channel);
      return {
        channel,
        settingsSchema: z.toJSONSchema(adapter.settingsSchema, { io: "input" }),
        secretsSchema: z.toJSONSchema(adapter.secretsSchema, { io: "input" }),
      };
    }),
  });
};
