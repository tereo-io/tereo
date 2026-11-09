import { prisma } from "../../utils/db/prisma.js";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../definitions/index.js";

/**
 * Makes a fresh domain SSO-only under a provider of its own, and returns the
 * domain, the provider's id and a cleanup that removes both.
 */
export const createSsoOnlyDomain = async () => {
  const id = randomBytes(5).toString("hex");
  const domain = `sso-${id}.test`;
  const provider = await prisma.identityProvider.create({
    data: {
      slug: `p-${id}`,
      displayName: "P",
      kind: "oidc",
      issuer: "https://idp.test",
      clientId: "c",
      clientSecret: "s",
      createdBy: SYSTEM_USER_ID,
    },
  });
  await prisma.identityProviderDomain.create({
    data: {
      providerId: provider.id,
      domain,
      organizationId: DEFAULT_ORGANIZATION_ID,
      ssoOnly: true,
      createdBy: SYSTEM_USER_ID,
    },
  });
  const remove = async () => {
    await prisma.identityProviderDomain.deleteMany({
      where: { providerId: provider.id },
    });
    await prisma.identityProvider.delete({ where: { id: provider.id } });
  };
  return { domain, providerId: provider.id, remove };
};
