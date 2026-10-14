import { clientSecretName } from "../../../../utils/identityProviders/clientSecret.js";
import { assertMayCountAsMfa } from "../../../../utils/identityProviders/mfaGuard.js";
import { getDefaultOrganizationId } from "../../../../utils/defaultOrganization.js";
import { formatProvider } from "../../../../utils/identityProviders/format.js";
import { BadRequestError, ConflictError } from "../../../../utils/errors.js";
import { CreateIdentityProviderSchema, RESERVED_SLUGS } from "./schemas.js";
import { adapterFor } from "../../../../utils/identityProviders/index.js";
import { mapUniqueViolation } from "../../../../utils/prismaErrors.js";
import { sealRowSecret } from "../../../../utils/sealedSecrets.js";
import { emitTx, logAuditTx } from "../../../../utils/outbox.js";
import { validateBody } from "../../../../utils/validateReq.js";
import { validateUser } from "../../../../utils/auth.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import { v7 as uuidv7 } from "uuid";

export const listIdentityProviders = async (_req: Request, res: Response) => {
  const providers = await db.identityProviders.list();
  res.json(providers.map(formatProvider));
};

export const createIdentityProvider = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(CreateIdentityProviderSchema, req);

  if (RESERVED_SLUGS.includes(body.slug)) {
    throw new BadRequestError(
      "reserved_slug",
      `The slug "${body.slug}" is reserved`
    );
  }
  if (await db.identityProviders.getBySlug(body.slug)) {
    throw new ConflictError(
      "An identity provider with this slug already exists",
      "slug_taken"
    );
  }

  if (body.countsAsMfa) await assertMayCountAsMfa(auth);

  const scopes = body.scopes ?? ["openid", "email", "profile"];
  await adapterFor(body.kind).validateConfig({
    kind: body.kind,
    issuer: body.issuer,
    clientId: body.clientId,
    clientSecret: body.clientSecret,
    scopes,
  });

  // The secret is sealed under the row's id, so the id comes first.
  const id = uuidv7();
  const clientSecret = await sealRowSecret(
    clientSecretName(id),
    body.clientSecret
  );

  const provider = await db.$transaction(async (tx) => {
    const created = await mapUniqueViolation(
      () =>
        db.identityProviders.create(
          {
            id,
            slug: body.slug,
            displayName: body.displayName,
            kind: body.kind,
            issuer: body.issuer,
            clientId: body.clientId,
            clientSecret,
            scopes,
            countsAsMfa: body.countsAsMfa ?? false,
            createdBy: auth.userId,
          },
          tx
        ),
      "An identity provider with this slug already exists",
      "slug_taken"
    );
    await logAuditTx(tx, {
      auth,
      organizationId: getDefaultOrganizationId(),
      action: "CREATE",
      entityType: "IdentityProvider",
      entityId: created.id,
      entityName: created.displayName,
      metadata: { slug: created.slug, kind: created.kind },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.identity-provider.created",
      entityType: "IdentityProvider",
      entityId: created.id,
      data: {
        id: created.id,
        slug: created.slug,
        displayName: created.displayName,
        kind: created.kind,
      },
    });
    return created;
  });

  res.status(201).json(formatProvider(provider));
};
