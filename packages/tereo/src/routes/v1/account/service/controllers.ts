import { formatOwnService } from "../../../../utils/transformers.js";
import { callerService } from "../../../../utils/callerService.js";
import { NotFoundError } from "../../../../utils/errors.js";
import { validateUser } from "../../../../utils/auth.js";
import { prisma } from "../../../../utils/db/prisma.js";
import type { Request, Response } from "express";

/** The calling service's own row and the access it holds. */
export const getOwnService = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const service = await callerService(auth);
  if (!service) throw new NotFoundError("This account belongs to no service");

  const access = await prisma.serviceAccess.findMany({
    where: { serviceId: service.id },
    select: { kind: true, target: true, status: true, decidedAt: true },
    orderBy: [{ kind: "asc" }, { target: "asc" }],
  });
  res.json(formatOwnService(service, access));
};
