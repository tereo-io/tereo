import { getDefaultOrganizationId } from "../../../../utils/defaultOrganization.js";
import { validateBody } from "../../../../utils/validateReq.js";
import { OAuth2Error } from "../../../../utils/errors.js";
import { validateUser } from "../../../../utils/auth.js";
import { logger } from "../../../../utils/logger.js";
import { UpdateSettingsSchema } from "./schemas.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import {
  computeChanges,
  emitTx,
  logAuditTx,
} from "../../../../utils/outbox.js";

export const getSettings = async (_req: Request, res: Response) => {
  const settings = await db.settings.getTotpSettings();

  res.json({
    totpPolicy: settings.totpPolicy,
    totpRecoveryCodeCount: settings.totpRecoveryCodeCount,
  });
};

export const updateSettings = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(UpdateSettingsSchema, req);

  if (Object.keys(body).length === 0) {
    throw new OAuth2Error("invalid_request", "No settings to update");
  }

  const updatedSettings = await db.$transaction(async (tx) => {
    const existing = await db.settings.getTotpSettings(tx);
    const updated = await db.settings.updateTotpSettings(body, tx);
    await logAuditTx(tx, {
      auth,
      action: "UPDATE",
      entityType: "SystemSettings",
      entityId: "totp",
      entityName: "TOTP settings",
      changes: computeChanges({ ...existing }, { ...updated }),
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.settings.updated",
      entityType: "SystemSettings",
      entityId: "totp",
      data: {
        totpPolicy: updated.totpPolicy,
        totpRecoveryCodeCount: updated.totpRecoveryCodeCount,
      },
    });
    return updated;
  });

  logger.debug(
    {
      adminId: auth.userId,
      changes: body,
    },
    "Settings updated"
  );

  res.json({
    totpPolicy: updatedSettings.totpPolicy,
    totpRecoveryCodeCount: updatedSettings.totpRecoveryCodeCount,
  });
};
