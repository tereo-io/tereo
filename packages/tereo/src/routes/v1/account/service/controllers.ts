import { callerService } from "../../../../utils/callerService.js";
import { formatService } from "../../../../utils/transformers.js";
import { NotFoundError } from "../../../../utils/errors.js";
import { validateUser } from "../../../../utils/auth.js";
import { prisma } from "../../../../utils/db/prisma.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";

/**
 * The calling service's own row: the declaration core last applied and the
 * access it holds. Its account, creator and secret overlap are admin detail.
 */
export const getOwnService = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const own = await callerService(auth);
  if (!own) throw new NotFoundError("This account belongs to no service");

  const [service, access] = await Promise.all([
    db.services.get(own.id),
    prisma.serviceAccess.findMany({
      where: { serviceId: own.id },
      select: { kind: true, target: true, status: true, decidedAt: true },
      orderBy: [{ kind: "asc" }, { target: "asc" }],
    }),
  ]);
  const formatted = formatService(service);
  res.json({
    id: formatted.id,
    slug: formatted.slug,
    name: formatted.name,
    namespace: formatted.namespace,
    isActive: formatted.isActive,
    provisioned: formatted.provisioned,
    unprovisionedAt: formatted.unprovisionedAt,
    declarationVersion: formatted.declarationVersion,
    declarationHash: formatted.declarationHash,
    declaredAt: formatted.declaredAt,
    access,
  });
};
