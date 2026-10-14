import { getDefaultOrganizationId } from "../../../../../../utils/defaultOrganization.js";
import { assertOrgAssignableRoles } from "../../../../../../utils/orgRoleAssignment.js";
import { formatDomain } from "../../../../../../utils/identityProviders/format.js";
import { mapUniqueViolation } from "../../../../../../utils/prismaErrors.js";
import { ConflictError } from "../../../../../../utils/errors.js";
import { logAuditTx } from "../../../../../../utils/outbox.js";
import { validateUser } from "../../../../../../utils/auth.js";
import { IdentityProviderIdParamSchema } from "../schemas.js";
import db from "../../../../../../utils/db/index.js";
import { assertProviderActive } from "./utils.js";
import { CreateDomainSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";

export const listDomains = async (req: Request, res: Response) => {
  const { id } = validateParams(IdentityProviderIdParamSchema, req);
  const domains = await db.identityProviders.listDomains(id);
  res.json(domains.map(formatDomain));
};

export const createDomain = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id: providerId } = validateParams(IdentityProviderIdParamSchema, req);
  const body = validateBody(CreateDomainSchema, req);

  await db.organizations.get(body.organizationId);
  if (await db.identityProviders.findDomain(body.domain)) {
    throw new ConflictError(
      "This domain is already claimed by an identity provider",
      "domain_taken"
    );
  }
  await assertOrgAssignableRoles(
    auth,
    body.organizationId,
    body.roleIds,
    new Set()
  );

  const created = await db.$transaction(async (tx) => {
    if (body.ssoOnly) await assertProviderActive(providerId, tx);
    const domain = await mapUniqueViolation(
      () =>
        db.identityProviders.createDomain(
          {
            providerId,
            domain: body.domain,
            organizationId: body.organizationId,
            autoAccept: body.autoAccept,
            ssoOnly: body.ssoOnly,
            createdBy: auth.userId,
          },
          tx
        ),
      "This domain is already claimed by an identity provider",
      "domain_taken"
    );
    await db.identityProviders.setDomainRoles(domain.id, body.roleIds, tx);
    await logAuditTx(tx, {
      auth,
      organizationId: getDefaultOrganizationId(),
      action: "CREATE",
      entityType: "IdentityProviderDomain",
      entityId: domain.id,
      entityName: domain.domain,
      metadata: {
        providerId,
        organizationId: body.organizationId,
        autoAccept: body.autoAccept,
        ssoOnly: body.ssoOnly,
        roleIds: body.roleIds,
      },
    });
    return domain;
  });

  res
    .status(201)
    .json(
      formatDomain(await db.identityProviders.getDomain(providerId, created.id))
    );
};
