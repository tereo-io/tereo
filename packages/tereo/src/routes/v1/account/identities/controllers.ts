import { formatUserIdentity } from "../../../../utils/identityProviders/identities.js";
import type { UpstreamRoundTrip } from "../../../../utils/identityProviders/begin.js";
import { ssoProviderElsewhere } from "../../../../utils/identityProviders/resolve.js";
import { UpstreamAuthError } from "../../../../utils/identityProviders/errors.js";
import { beginUpstreamAuth } from "../../../../utils/identityProviders/begin.js";
import { validateBody } from "../../../../utils/validateReq.js";
import { validateUser } from "../../../../utils/auth.js";
import { logger } from "../../../../utils/logger.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import { StartLinkSchema } from "./schemas.js";
import {
  UPSTREAM_AUTH_TTL_SECONDS,
  setUpstreamAuthCookie,
} from "../../../../utils/cookies.js";
import {
  BadGatewayError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../../utils/errors.js";

export const listIdentities = async (req: Request, res: Response) => {
  const { userId } = validateUser(req);
  const identities = await db.userIdentities.listForUser(userId);
  res.json(identities.map(formatUserIdentity));
};

export const startLink = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(StartLinkSchema, req);
  if (auth.userType !== "human") {
    throw new ForbiddenError("Only a person can link a sign-in provider");
  }

  const provider = await db.identityProviders.getBySlug(body.provider);
  if (!provider?.isActive) {
    throw new NotFoundError("Identity provider not found");
  }
  const required = await ssoProviderElsewhere(auth.email, provider.id);
  if (required) {
    throw new ConflictError(
      `Your account must sign in with ${required.displayName}`,
      "sso_required"
    );
  }

  let trip: UpstreamRoundTrip;
  try {
    trip = await beginUpstreamAuth(provider);
  } catch (err) {
    if (!(err instanceof UpstreamAuthError)) throw err;
    logger.warn({ err, provider: provider.slug }, "Upstream link failed");
    throw new BadGatewayError(
      err.code,
      "The identity provider could not be reached"
    );
  }

  await db.upstreamAuth.createSession({
    stateHash: trip.stateHash,
    providerId: provider.id,
    purpose: "link",
    userId: auth.userId,
    nonce: trip.nonce,
    codeVerifier: trip.codeVerifier,
    expiresAt: new Date(Date.now() + UPSTREAM_AUTH_TTL_SECONDS * 1000),
  });

  setUpstreamAuthCookie(res, trip.state);
  res.json({ redirect_url: trip.providerUrl.toString() });
};
