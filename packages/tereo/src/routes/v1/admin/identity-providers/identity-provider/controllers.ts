import { broadcastIdentityProviderInvalidate } from "../../../../../utils/cacheBroadcast.js";
import { assertMayCountAsMfa } from "../../../../../utils/identityProviders/mfaGuard.js";
import { getDefaultOrganizationId } from "../../../../../utils/defaultOrganization.js";
import { formatProvider } from "../../../../../utils/identityProviders/format.js";
import { BadRequestError, ConflictError } from "../../../../../utils/errors.js";
import { adapterFor } from "../../../../../utils/identityProviders/index.js";
import { mapUniqueViolation } from "../../../../../utils/prismaErrors.js";
import { sealRowSecret } from "../../../../../utils/sealedSecrets.js";
import type { AuthContext } from "../../../../../middleware/auth.js";
import { assertGlobalAdmin } from "../../../../../utils/grants.js";
import type { Prisma } from "../../../../../utils/db/prisma.js";
import { validateUser } from "../../../../../utils/auth.js";
import db from "../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import { RESERVED_SLUGS } from "../schemas.js";
import {
  openProviderSecret,
  clientSecretName,
} from "../../../../../utils/identityProviders/clientSecret.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";
import {
  computeChanges,
  emitTx,
  logAuditTx,
} from "../../../../../utils/outbox.js";
import {
  IdentityProviderIdParamSchema,
  UpdateIdentityProviderSchema,
} from "./schemas.js";

export const getIdentityProvider = async (req: Request, res: Response) => {
  const { id } = validateParams(IdentityProviderIdParamSchema, req);
  res.json(formatProvider(await db.identityProviders.get(id)));
};

/**
 * An SSO-only domain force-links its password users to whoever the provider's
 * issuer and client vouch for, so pointing them elsewhere hands those
 * accounts over.
 */
const repointsSsoOnly = async (
  id: string,
  row: { issuer: string | null; clientId: string },
  body: { issuer?: string; clientId?: string },
  tx?: Prisma.TransactionClient
) =>
  ((body.issuer !== undefined && body.issuer !== row.issuer) ||
    (body.clientId !== undefined && body.clientId !== row.clientId)) &&
  (await db.identityProviders.hasSsoOnlyDomain(id, tx));

const assertMayRepointSsoOnly = (
  auth: Pick<AuthContext, "userId" | "ceiling">,
  tx?: Prisma.TransactionClient
) =>
  assertGlobalAdmin(
    auth,
    "Only an administrator (global admin) can change the issuer or client ID of a provider with an SSO-only domain",
    tx
  );

/**
 * The trust behind countsAsMfa is in who asserts the identity, so moving a
 * provider that has it to another issuer or client grants it anew.
 */
const grantsMfaTrust = (
  row: { countsAsMfa: boolean; issuer: string | null; clientId: string },
  body: { countsAsMfa?: boolean; issuer?: string; clientId?: string }
) => {
  if (!(body.countsAsMfa ?? row.countsAsMfa)) return false;
  return (
    !row.countsAsMfa ||
    (body.issuer !== undefined && body.issuer !== row.issuer) ||
    (body.clientId !== undefined && body.clientId !== row.clientId)
  );
};

export const updateIdentityProvider = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(IdentityProviderIdParamSchema, req);
  const body = validateBody(UpdateIdentityProviderSchema, req);
  const existing = await db.identityProviders.get(id);

  if (body.slug !== undefined && body.slug !== existing.slug) {
    if (RESERVED_SLUGS.includes(body.slug)) {
      throw new BadRequestError(
        "reserved_slug",
        `The slug "${body.slug}" is reserved`
      );
    }
    // The slug is in the callback URL registered at the provider, and
    // identities are matched through it.
    if (await db.identityProviders.hasIdentities(id)) {
      throw new ConflictError(
        "The slug cannot change once users have linked identities",
        "slug_in_use"
      );
    }
    if (await db.identityProviders.getBySlug(body.slug)) {
      throw new ConflictError(
        "An identity provider with this slug already exists",
        "slug_taken"
      );
    }
  }

  // A subject is unique only within its issuer: under another one, the same
  // `sub` may be a different person, and every link would point at them. A
  // pending invite would link whoever the new issuer vouches for.
  const issuerChanges =
    body.issuer !== undefined && body.issuer !== existing.issuer;
  if (issuerChanges) {
    if (await db.identityProviders.hasIdentities(id)) {
      throw new ConflictError(
        "The issuer cannot change once users have linked identities",
        "issuer_in_use"
      );
    }
    if (await db.identityProviders.hasPendingInvites(id)) {
      throw new ConflictError(
        "The issuer cannot change while identity invites for this provider are pending; withdraw them first",
        "provider_has_invites"
      );
    }
  }

  // The stored secret was issued for this issuer and client: sent anywhere
  // else, it would hand the secret to whoever runs the new endpoint.
  const clientChanges =
    body.clientId !== undefined && body.clientId !== existing.clientId;
  if ((issuerChanges || clientChanges) && body.clientSecret === undefined) {
    throw new BadRequestError(
      "client_secret_required",
      "Changing the issuer or client ID needs the client secret in the same request"
    );
  }

  if (grantsMfaTrust(existing, body)) await assertMayCountAsMfa(auth);
  if (await repointsSsoOnly(id, existing, body)) {
    await assertMayRepointSsoOnly(auth);
  }

  const touchesConfig =
    body.issuer !== undefined ||
    body.clientId !== undefined ||
    body.clientSecret !== undefined ||
    body.scopes !== undefined;
  if (touchesConfig) {
    await adapterFor(existing.kind).validateConfig({
      kind: existing.kind,
      issuer: body.issuer ?? existing.issuer ?? "",
      clientId: body.clientId ?? existing.clientId,
      clientSecret: body.clientSecret ?? (await openProviderSecret(existing)),
      scopes: body.scopes ?? existing.scopes,
    });
  }

  const data = {
    slug: body.slug,
    displayName: body.displayName,
    issuer: body.issuer,
    clientId: body.clientId,
    scopes: body.scopes,
    countsAsMfa: body.countsAsMfa,
    clientSecret:
      body.clientSecret === undefined
        ? undefined
        : await sealRowSecret(clientSecretName(id), body.clientSecret),
  };

  const provider = await db.$transaction(async (tx) => {
    // Again on the locked row: a concurrent PATCH could have turned the flag
    // on, or a domain SSO-only, since the checks above.
    const current = await db.identityProviders.lockForUpdate(id, tx);
    if (grantsMfaTrust(current, body)) await assertMayCountAsMfa(auth);
    if (await repointsSsoOnly(id, current, body, tx)) {
      await assertMayRepointSsoOnly(auth, tx);
    }
    const updated = await mapUniqueViolation(
      () => db.identityProviders.update(id, data, tx),
      "An identity provider with this slug already exists",
      "slug_taken"
    );
    await logAuditTx(tx, {
      auth,
      organizationId: getDefaultOrganizationId(),
      action: "UPDATE",
      entityType: "IdentityProvider",
      entityId: id,
      entityName: updated.displayName,
      changes: computeChanges(
        formatProvider(existing),
        formatProvider(updated)
      ),
      metadata:
        body.clientSecret === undefined ? undefined : { secretReplaced: true },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.identity-provider.updated",
      entityType: "IdentityProvider",
      entityId: id,
      data: {
        id,
        slug: updated.slug,
        displayName: updated.displayName,
        kind: updated.kind,
      },
    });
    return updated;
  });

  await broadcastIdentityProviderInvalidate(id);
  res.json(formatProvider(provider));
};

export const deactivateIdentityProvider = async (
  req: Request,
  res: Response
) => {
  await setActive(req, res, false);
};

export const activateIdentityProvider = async (req: Request, res: Response) => {
  const { id } = validateParams(IdentityProviderIdParamSchema, req);
  // It may have been down or reconfigured at the provider while inactive.
  const provider = await db.identityProviders.get(id);
  await adapterFor(provider.kind).validateConfig({
    kind: provider.kind,
    issuer: provider.issuer ?? "",
    clientId: provider.clientId,
    clientSecret: await openProviderSecret(provider),
    scopes: provider.scopes,
  });
  await setActive(req, res, true);
};

const setActive = async (req: Request, res: Response, isActive: boolean) => {
  const auth = validateUser(req);
  const { id } = validateParams(IdentityProviderIdParamSchema, req);

  const provider = await db.$transaction(async (tx) => {
    // Under the row lock a domain turning SSO-only takes too, so the two
    // can't both pass their checks.
    await db.identityProviders.lockForUpdate(id, tx);
    // SSO-only users could not sign in at all.
    if (!isActive && (await db.identityProviders.hasSsoOnlyDomain(id, tx))) {
      throw new ConflictError(
        "A domain of this provider is SSO-only; turn that off before deactivating",
        "sso_only_domain"
      );
    }
    const updated = await db.identityProviders.setActive(id, isActive, tx);
    await logAuditTx(tx, {
      auth,
      organizationId: getDefaultOrganizationId(),
      action: "UPDATE",
      entityType: "IdentityProvider",
      entityId: id,
      entityName: updated.displayName,
      metadata: { action: isActive ? "activated" : "deactivated" },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: isActive
        ? "auth.identity-provider.activated"
        : "auth.identity-provider.deactivated",
      entityType: "IdentityProvider",
      entityId: id,
      data: { id, slug: updated.slug, displayName: updated.displayName },
    });
    return updated;
  });

  await broadcastIdentityProviderInvalidate(id);
  res.json(formatProvider(provider));
};
