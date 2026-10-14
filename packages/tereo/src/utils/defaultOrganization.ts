import { DEFAULT_ORGANIZATION } from "../definitions/index.js";
import { prisma } from "./db/prisma.js";
import { logger } from "./logger.js";

const DEFAULT_ORG_ID = DEFAULT_ORGANIZATION.id;
const DEFAULT_ORG_CODE = DEFAULT_ORGANIZATION.code;
const DEFAULT_ORG_SLUG = DEFAULT_ORGANIZATION.slug;
const DEFAULT_ORG_NAME = DEFAULT_ORGANIZATION.name;

let cachedDefaultOrg: {
  id: string;
  name: string;
  slug: string;
  code: string;
} | null = null;

/**
 * Called at server startup (after seed creates the row). Found by its fixed
 * id: setup renames the organization, slug included. Caches the org so webhook emitters can call getDefaultOrganizationId() synchronously without a DB hit.
 */
export async function ensureDefaultOrganization(): Promise<{
  id: string;
  name: string;
  slug: string;
  code: string;
}> {
  let org = await prisma.organization.findUnique({
    where: { id: DEFAULT_ORG_ID },
  });
  if (org) {
    logger.info(
      { organizationId: org.id },
      "Default organization already exists"
    );
  } else {
    // ON CONFLICT DO NOTHING: another replica or the seed may insert it first.
    await prisma.organization.createMany({
      data: [
        {
          id: DEFAULT_ORG_ID,
          name: DEFAULT_ORG_NAME,
          slug: DEFAULT_ORG_SLUG,
          code: DEFAULT_ORG_CODE,
          isDefault: true,
        },
      ],
      skipDuplicates: true,
    });
    org = await prisma.organization.findUniqueOrThrow({
      where: { id: DEFAULT_ORG_ID },
    });
    logger.info({ organizationId: org.id }, "Ensured default organization");
  }

  cachedDefaultOrg = {
    id: org.id,
    name: org.name,
    slug: org.slug,
    code: org.code,
  };
  return cachedDefaultOrg;
}

/**
 * Returns the default organization id. Throws if `ensureDefaultOrganization`
 * has not been called yet — callers must run during/after server startup.
 */
export function getDefaultOrganizationId(): string {
  if (!cachedDefaultOrg) {
    throw new Error(
      "Default organization not loaded — ensureDefaultOrganization() must run before any webhook emission"
    );
  }
  return cachedDefaultOrg.id;
}
