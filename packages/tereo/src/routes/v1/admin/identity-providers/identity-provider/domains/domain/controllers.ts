import { getDefaultOrganizationId } from "../../../../../../../utils/defaultOrganization.js";
import { assertOrgAssignableRoles } from "../../../../../../../utils/orgRoleAssignment.js";
import { formatDomain } from "../../../../../../../utils/identityProviders/format.js";
import { mapUniqueViolation } from "../../../../../../../utils/prismaErrors.js";
import { ConflictError } from "../../../../../../../utils/errors.js";
import { validateUser } from "../../../../../../../utils/auth.js";
import db from "../../../../../../../utils/db/index.js";
import { UpdateDomainSchema } from "../schemas.js";
import { DomainIdParamSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../../utils/validateReq.js";
import {
  computeChanges,
  emitTx,
  logAuditTx,
} from "../../../../../../../utils/outbox.js";
import {
  assertMayChangeSsoOnly,
  assertProviderActive,
  changesSsoOnly,
  emitDomainTx,
  endSessionsLinkedElsewhere,
} from "../utils.js";

export const getDomain = async (req: Request, res: Response) => {
  const { id, domainId } = validateParams(DomainIdParamSchema, req);
  res.json(formatDomain(await db.identityProviders.getDomain(id, domainId)));
};

export const updateDomain = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id: providerId, domainId } = validateParams(DomainIdParamSchema, req);
  const body = validateBody(UpdateDomainSchema, req);
  const existing = await db.identityProviders.getDomain(providerId, domainId);

  if (body.organizationId !== undefined) {
    await db.organizations.get(body.organizationId);
  }
  if (body.domain !== undefined && body.domain !== existing.domain) {
    if (await db.identityProviders.findDomain(body.domain)) {
      throw new ConflictError(
        "This domain is already claimed by an identity provider",
        "domain_taken"
      );
    }
  }
  const currentRoleIds = existing.roles.map(({ role }) => role.id);
  const movesOrg =
    body.organizationId !== undefined &&
    body.organizationId !== existing.organizationId;
  if (body.roleIds !== undefined || movesOrg) {
    // Roles the domain already hands out in its organization stay as they
    // are; moved to another organization, every role is a new grant there,
    // including the current ones when no roleIds are sent.
    await assertOrgAssignableRoles(
      auth,
      body.organizationId ?? existing.organizationId,
      body.roleIds ?? currentRoleIds,
      movesOrg ? new Set() : new Set(currentRoleIds)
    );
  }

  const closes = await db.$transaction(async (tx) => {
    // Every domain write takes the provider's lock, so the row read under it
    // holds until this one is written.
    await db.identityProviders.lockForUpdate(providerId, tx);
    const current = await db.identityProviders.getDomain(
      providerId,
      domainId,
      tx
    );
    if (changesSsoOnly(current, body)) await assertMayChangeSsoOnly(auth, tx);
    if (body.ssoOnly) await assertProviderActive(providerId, tx);
    await mapUniqueViolation(
      () =>
        db.identityProviders.updateDomain(
          domainId,
          {
            domain: body.domain,
            organizationId: body.organizationId,
            autoAccept: body.autoAccept,
            ssoOnly: body.ssoOnly,
          },
          tx
        ),
      "This domain is already claimed by an identity provider",
      "domain_taken"
    );
    if (body.roleIds !== undefined) {
      await db.identityProviders.setDomainRoles(domainId, body.roleIds, tx);
    }
    const updated = await db.identityProviders.getDomain(
      providerId,
      domainId,
      tx
    );
    await logAuditTx(tx, {
      auth,
      organizationId: getDefaultOrganizationId(),
      action: "UPDATE",
      entityType: "IdentityProviderDomain",
      entityId: domainId,
      entityName: updated.domain,
      changes: computeChanges(formatDomain(existing), formatDomain(updated)),
      metadata: { providerId },
    });
    await emitDomainTx(
      tx,
      "auth.identity-provider.domain-updated",
      providerId,
      updated
    );
    // Newly SSO-only, or SSO-only at a new domain: its users' identities at
    // other providers stop working.
    return (
      updated.ssoOnly && (!current.ssoOnly || updated.domain !== current.domain)
    );
  });

  if (closes) await endSessionsLinkedElsewhere(auth, providerId, domainId);

  res.json(
    formatDomain(await db.identityProviders.getDomain(providerId, domainId))
  );
};

export const deleteDomain = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id: providerId, domainId } = validateParams(DomainIdParamSchema, req);
  const existing = await db.identityProviders.getDomain(providerId, domainId);

  await db.$transaction(async (tx) => {
    await db.identityProviders.lockForUpdate(providerId, tx);
    const current = await db.identityProviders.getDomain(
      providerId,
      domainId,
      tx
    );
    if (current.ssoOnly) await assertMayChangeSsoOnly(auth, tx);
    await db.identityProviders.deleteDomain(domainId, tx);
    await logAuditTx(tx, {
      auth,
      organizationId: getDefaultOrganizationId(),
      action: "DELETE",
      entityType: "IdentityProviderDomain",
      entityId: domainId,
      entityName: existing.domain,
      metadata: { providerId },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.identity-provider.domain-deleted",
      entityType: "IdentityProviderDomain",
      entityId: domainId,
      data: {
        providerId,
        id: domainId,
        domain: current.domain,
        organizationId: current.organizationId,
        ssoOnly: current.ssoOnly,
      },
    });
  });

  res.status(204).send();
};
