import { PERMISSION_CATALOG, SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";

/**
 * Owner of the permissions, roles and event types tests make directly in the
 * database. It never registers a declaration, so nothing it owns is ever
 * marked missing or retired — unlike core, whose declaration would retire
 * test-made items a day after they first appear.
 */
export const TEST_SERVICE = {
  id: "00000000-0000-7003-0000-000000000001",
  slug: "test-fixtures",
  name: "Test fixtures",
  namespace: "test-fixtures",
} as const;

export const TEST_SERVICE_ID = TEST_SERVICE.id;

export const ensureTestService = async () => {
  await prisma.service.upsert({
    where: { id: TEST_SERVICE.id },
    update: {},
    create: { ...TEST_SERVICE, createdBy: SYSTEM_USER_ID },
  });
};

const CORE_PERMISSIONS = new Set(PERMISSION_CATALOG.map((p) => p.name));

/**
 * A permission by name: core's own as registered, anything else owned by
 * the test service (and taken back from core if an older run left it there).
 */
export const ensurePermission = (name: string, displayName = name) =>
  prisma.permission.upsert({
    where: { name },
    update: CORE_PERMISSIONS.has(name)
      ? {}
      : { serviceId: TEST_SERVICE_ID, missingSince: null, retiredAt: null },
    create: { name, displayName, serviceId: TEST_SERVICE_ID },
  });

/**
 * Make an existing client a service's client, so its slug can stand in a
 * token's audience. Returns the slug.
 */
export const makeServiceOf = async (clientRowId: string): Promise<string> => {
  const slug = `svc-${clientRowId.replace(/-/g, "").slice(-12)}`;
  await prisma.service.create({
    data: {
      slug,
      name: slug,
      namespace: slug,
      clientId: clientRowId,
      createdBy: SYSTEM_USER_ID,
    },
  });
  return slug;
};
