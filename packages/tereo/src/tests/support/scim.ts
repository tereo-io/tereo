import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { ensureTestOrganization } from "./principals.js";
import { mintToken } from "../../utils/scim/tokens.js";
import { prisma } from "../../utils/db/prisma.js";
import type { JsonResponse } from "./http.js";
import { randomBytes } from "node:crypto";
import { CORE_URL } from "./coreUrl.js";

/**
 * A provider, its domains (bound to `organizationId`, default a fresh test
 * organization), a SCIM connection and one live token, written directly.
 */
export const createScimConnection = async (
  opts: { domains?: string[]; organizationId?: string; roleIds?: string[] } = {}
) => {
  const id = randomBytes(5).toString("hex");
  const organizationId =
    opts.organizationId ?? (await ensureTestOrganization(`scim-org-${id}`));
  const domains = opts.domains ?? [`scim-${id}.test`];
  const provider = await prisma.identityProvider.create({
    data: {
      slug: `p-${id}`,
      displayName: "SCIM IdP",
      kind: "oidc",
      issuer: "https://idp.test",
      clientId: "c",
      clientSecret: "s",
      createdBy: SYSTEM_USER_ID,
    },
  });
  for (const domain of domains) {
    const row = await prisma.identityProviderDomain.create({
      data: {
        providerId: provider.id,
        domain,
        organizationId,
        createdBy: SYSTEM_USER_ID,
      },
    });
    if (opts.roleIds?.length) {
      await prisma.identityProviderDomainRole.createMany({
        data: opts.roleIds.map((roleId) => ({ domainId: row.id, roleId })),
      });
    }
  }
  const connection = await prisma.scimConnection.create({
    data: { providerId: provider.id, createdBy: SYSTEM_USER_ID },
  });
  const { token, hash } = mintToken();
  await prisma.scimToken.create({
    data: { connectionId: connection.id, hash, createdBy: SYSTEM_USER_ID },
  });
  return {
    providerId: provider.id,
    connectionId: connection.id,
    token,
    domain: domains[0],
    organizationId,
  };
};

export const scimFetch = async (
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<JsonResponse> => {
  const response = await fetch(`${CORE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/scim+json",
      ...(body !== undefined && { "Content-Type": "application/scim+json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
