import { notifyOrgMembershipChanged } from "../../../../../../websocket/emitters/index.js";
import { getDefaultOrganizationId } from "../../../../../../utils/defaultOrganization.js";
import { formatOrganizationMember } from "../../../../../../utils/transformers.js";
import { requireOrgRole } from "../../../../../../utils/orgRoleAuth.js";
import { SYSTEM_USER_ID } from "../../../../../../definitions/index.js";
import { emitTx, logAuditTx } from "../../../../../../utils/outbox.js";
import { BadRequestError } from "../../../../../../utils/errors.js";
import { validateUser } from "../../../../../../utils/auth.js";
import db from "../../../../../../utils/db/index.js";
import { OrgIdParamSchema } from "../../schemas.js";
import type { Request, Response } from "express";
import { AddMemberSchema } from "./schemas.js";
import {
  OrgMemberRole,
  UserType,
} from "../../../../../../../prisma/generated/client/index.js";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";

export const listMembers = async (req: Request, res: Response) => {
  const params = validateParams(OrgIdParamSchema, req);
  await requireOrgRole("member", req, params.id);
  // getAny: memberships survive archive, so the read-only member list
  // must stay visible for archived organizations.
  await db.organizations.getAny(params.id);

  const members = await db.organizations.getMembers(params.id);
  res.json({
    organizationId: params.id,
    members: members.map(formatOrganizationMember),
  });
};

export const addMember = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(OrgIdParamSchema, req);
  const body = validateBody(AddMemberSchema, req);

  await db.organizations.get(params.id);
  const user = await db.users.getFromBody(body.userId);
  // Only a person who can sign in can be a member: core's system user and a
  // service's account act for every organization, and an inactive user
  // would hold a membership nobody can use.
  if (
    user.id === SYSTEM_USER_ID ||
    user.userType === UserType.service_account ||
    !user.isActive
  ) {
    throw new BadRequestError(
      "user_not_addable",
      "Only an active person can be added to an organization"
    );
  }

  const member = await db.$transaction(async (tx) => {
    const created = await db.organizations.addMember(
      params.id,
      body.userId,
      body.memberRole as OrgMemberRole,
      tx
    );
    await logAuditTx(tx, {
      auth,
      organizationId: params.id,
      action: "CREATE",
      entityType: "OrganizationMember",
      entityId: created.id,
      entityName: created.user.email,
      metadata: { userId: created.userId, memberRole: created.memberRole },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.organization.member-added",
      entityType: "OrganizationMember",
      entityId: created.id,
      data: {
        organizationId: params.id,
        userId: created.userId,
        email: created.user.email,
        memberRole: created.memberRole,
      },
    });
    return created;
  });
  notifyOrgMembershipChanged(member.userId, params.id);
  res.status(201).json(formatOrganizationMember(member));
};
