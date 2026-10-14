import { UserType } from "../../../prisma/generated/client/index.js";
import { prisma } from "./client.js";
import env from "../../env.js";
import {
  CORE_SCOPES,
  DEFAULT_ORGANIZATION,
  LOGIN_CLIENT,
  SYSTEM_USER,
  loginClientConfig,
  loginClientRedirectUris,
} from "../../definitions/index.js";

const OIDC_SCOPES = [
  { name: "openid", description: "OpenID Connect scope" },
  { name: "profile", description: "Access to user profile information" },
  { name: "email", description: "Access to user email address" },
  { name: "offline_access", description: "Access to refresh tokens" },
];

/**
 * The OIDC scopes, and core's API scopes (definitions/coreScopes.ts), whose
 * descriptions the consent screen shows and follow the code.
 */
export async function seedDefaultScopes() {
  for (const scope of OIDC_SCOPES) {
    await prisma.scope.upsert({
      where: { name: scope.name },
      update: {},
      create: scope,
    });
  }
  for (const { name, description } of CORE_SCOPES) {
    await prisma.scope.upsert({
      where: { name },
      update: { description },
      create: { name, description },
    });
  }
  console.error("Ensured default scopes exist");
}

/**
 * Core's own principal. The password hash is not in `salt:key` form, so no
 * password verifies against it; as a service account with no OAuth client it
 * cannot log in or obtain a token either.
 */
export async function seedSystemUser() {
  const { id, email, name } = SYSTEM_USER;
  const user = await prisma.user.upsert({
    where: { id },
    update: {},
    create: {
      id,
      email,
      name,
      passwordHash: "!",
      userType: UserType.service_account,
      isActive: true,
    },
  });
  console.error(`System user ready (${user.id})`);
  return user;
}

/**
 * The UI's login client, under its fixed client_id. Owned by the system user
 * — no admin exists yet. Its redirect URIs (`${UI_BASE_URL}/callback`, plus
 * other loopback callbacks outside production — `loginClientRedirectUris`),
 * grant types and client type are derived; core sets them again on every
 * start (utils/loginClient.ts), and admins cannot edit them.
 */
export async function seedDefaultClient() {
  const { clientId, name } = LOGIN_CLIENT;
  const config = loginClientConfig(env.UI_BASE_URL);

  let existing =
    (await prisma.oAuthClient.findUnique({ where: { clientId } })) ??
    (await prisma.oAuthClient.findFirst({ where: { name } }));

  if (!existing) {
    // ON CONFLICT DO NOTHING: a seed running at the same time may insert it
    // first, and then its row is brought in line like any existing one.
    const { count } = await prisma.oAuthClient.createMany({
      data: [
        {
          clientId,
          clientSecret: null,
          name,
          ...config,
          audience: [],
          ownerId: SYSTEM_USER.id,
        },
      ],
      skipDuplicates: true,
    });
    const client = await prisma.oAuthClient.findUniqueOrThrow({
      where: { clientId },
    });
    if (count === 1) {
      console.error(`Created OAuth client: ${clientId}`);
      console.error(`  Redirect URIs: ${config.redirectUris.join(", ")}`);
      return client;
    }
    existing = client;
  }

  const redirectUris = loginClientRedirectUris(
    existing.redirectUris,
    env.UI_BASE_URL,
    env.NODE_ENV === "production"
  );
  // Rows reference the client by `id`, so rewriting a random legacy
  // client_id breaks nothing but sessions holding the old one.
  const client = await prisma.oAuthClient.update({
    where: { id: existing.id },
    data: {
      clientId,
      clientType: config.clientType,
      redirectUris,
      grantTypes: config.grantTypes,
      scopes: [...new Set([...existing.scopes, ...config.scopes])],
    },
  });
  console.error(`Ensured OAuth client: ${clientId}`);
  console.error(`  Redirect URIs: ${redirectUris.join(", ")}`);
  return client;
}

/**
 * The default organization, under its fixed id. Setup names it and makes the
 * first admin its owner; found by id because setup changes the slug.
 */
export async function seedDefaultOrganization() {
  const { id, name, slug, code } = DEFAULT_ORGANIZATION;
  const existing = await prisma.organization.findUnique({ where: { id } });
  if (existing) {
    console.error("Default organization already exists");
    return existing;
  }
  // ON CONFLICT DO NOTHING: a seed or core start running at the same time
  // may insert it first.
  await prisma.organization.createMany({
    data: [{ id, name, slug, code, isDefault: true }],
    skipDuplicates: true,
  });
  const org = await prisma.organization.findUniqueOrThrow({ where: { id } });
  console.error(`Ensured default organization (${org.id})`);
  return org;
}
