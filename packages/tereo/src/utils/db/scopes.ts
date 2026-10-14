import { prisma } from "./prisma.js";

export const search = async (scopes: string[]) => {
  return await prisma.scope.findMany({
    where: { name: { in: scopes } },
  });
};
