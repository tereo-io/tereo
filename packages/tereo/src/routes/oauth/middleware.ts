import type { NextFunction, Request, Response } from "express";

// RFC 6749 section 5.1: responses carrying tokens, codes or session handles
// must not be cached.
export const noStore = (_req: Request, res: Response, next: NextFunction) => {
  res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
  next();
};
