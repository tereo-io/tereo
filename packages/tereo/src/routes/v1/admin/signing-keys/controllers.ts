import { getDefaultOrganizationId } from "../../../../utils/defaultOrganization.js";
import { emitTx, logAuditTx } from "../../../../utils/outbox.js";
import { validateBody } from "../../../../utils/validateReq.js";
import { validateUser } from "../../../../utils/auth.js";
import { RotateSigningKeySchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  describeSigningKeys,
  rotateSigningKey,
} from "../../../../utils/keys.js";

export const listSigningKeys = async (_req: Request, res: Response) => {
  res.json({ keys: describeSigningKeys() });
};

/**
 * A new JWT signing key is published at once and signs from `activatesAt`;
 * the previous one signs until then, and keeps verifying, and stays in the
 * JWKS, until tokens it signed have expired. With `immediate` the new key
 * signs at once and every older one is deleted. Audited, and
 * `core.signing-key.rotated` is emitted.
 */
export const rotateSigningKeys = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { immediate } = validateBody(RotateSigningKeySchema, req);
  const { keys, activatesAt } = await rotateSigningKey(
    { immediate },
    async (tx, { kid, activatesAt, retired }) => {
      const data = {
        kid,
        activatesAt,
        retiredKid: retired?.kid ?? null,
        retiredKidExpiresAt: retired?.expiresAt ?? null,
      };
      await logAuditTx(tx, {
        auth,
        action: "CREATE",
        entityType: "SigningKey",
        entityId: kid,
        metadata: { action: "signing_key_rotated", ...data },
      });
      // App services that cache the JWKS can refetch it.
      await emitTx(tx, {
        organizationId: getDefaultOrganizationId(),
        eventType: "core.signing-key.rotated",
        entityType: "SigningKey",
        entityId: kid,
        data,
      });
    }
  );
  res.json({ keys, activatesAt });
};
