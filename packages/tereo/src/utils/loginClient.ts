import { prisma } from "./db/prisma.js";
import { logger } from "./logger.js";
import env from "../env.js";
import {
  LOGIN_CLIENT,
  loginClientConfig,
  loginClientRedirectUris,
} from "../definitions/index.js";

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

export interface EnsureLoginClientOptions {
  uiBaseUrl?: string;
  production?: boolean;
}

/**
 * Bring the admin UI's login client in line with UI_BASE_URL on every start:
 * its grant types and client type are derived, not edited, and the scopes
 * the UI asks for stay granted. Its redirect URIs are exactly the UI's
 * callback in production, and gain it beside the other loopback ones
 * elsewhere (`loginClientRedirectUris`). The seed creates the client.
 */
export const ensureLoginClient = async ({
  uiBaseUrl = env.UI_BASE_URL,
  production = env.NODE_ENV === "production",
}: EnsureLoginClientOptions = {}): Promise<void> => {
  const client = await prisma.oAuthClient.findUnique({
    where: { clientId: LOGIN_CLIENT.clientId },
  });
  if (!client) {
    logger.warn(
      { clientId: LOGIN_CLIENT.clientId },
      "The admin UI's login client is missing; run the seed"
    );
    return;
  }

  const want = loginClientConfig(uiBaseUrl);
  const redirectUris = loginClientRedirectUris(
    client.redirectUris,
    uiBaseUrl,
    production
  );
  const scopes = [...new Set([...client.scopes, ...want.scopes])];
  if (
    client.clientType === want.clientType &&
    sameSet(client.redirectUris, redirectUris) &&
    client.redirectUris[0] === redirectUris[0] &&
    sameSet(client.grantTypes, want.grantTypes) &&
    sameSet(client.scopes, scopes)
  ) {
    return;
  }

  await prisma.oAuthClient.update({
    where: { id: client.id },
    data: {
      clientType: want.clientType,
      redirectUris,
      grantTypes: want.grantTypes,
      scopes,
    },
  });
  logger.info(
    { clientId: client.clientId, redirectUris },
    "Updated the admin UI's login client from UI_BASE_URL"
  );
};
