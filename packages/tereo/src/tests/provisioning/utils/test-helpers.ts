import { prisma } from "../../../utils/db/prisma.js";

// Production never deletes a service; tests do, with everything that would
// otherwise hold it: its declared roles and permissions, its access rows, and
// its service-account user with that user's roles and audit entries.
export async function removeServices(slugs: string[]) {
  const services = await prisma.service.findMany({
    where: { slug: { in: slugs } },
    include: { client: { include: { serviceAccountUser: true } } },
  });
  const ids = services.map((s) => s.id);
  const clientIds = services.flatMap((s) => (s.client ? [s.client.id] : []));
  const userIds = services.flatMap((s) =>
    s.client?.serviceAccountUser ? [s.client.serviceAccountUser.id] : []
  );
  await prisma.serviceAccess.deleteMany({ where: { serviceId: { in: ids } } });
  await prisma.role.deleteMany({ where: { serviceId: { in: ids } } });
  await prisma.permission.deleteMany({ where: { serviceId: { in: ids } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.auditLogEntry.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.service.deleteMany({ where: { id: { in: ids } } });
  // Its tokens and login-flow rows go with it (ON DELETE CASCADE).
  await prisma.oAuthClient.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

export async function removeLoginClients(clientIds: string[]) {
  await prisma.oAuthClient.deleteMany({
    where: { clientId: { in: clientIds }, service: { is: null } },
  });
}

// Rows a failed run left behind, by the prefixes provisioning.test.ts uses.
export async function cleanupAllTestEntities() {
  const services = await prisma.service.findMany({
    where: {
      OR: [
        { slug: { startsWith: "prov-" } },
        { slug: { startsWith: "hand-" } },
      ],
    },
    select: { slug: true },
  });
  await removeServices(services.map((s) => s.slug));
  const clients = await prisma.oAuthClient.findMany({
    where: { clientId: { startsWith: "prov-client-" }, service: { is: null } },
    select: { clientId: true },
  });
  await removeLoginClients(clients.map((c) => c.clientId));
}
