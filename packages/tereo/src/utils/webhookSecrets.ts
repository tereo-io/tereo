import { prisma } from "./db/prisma.js";
import { logger } from "./logger.js";
import { randomBytes } from "crypto";
import {
  previousSecretExpiry,
  type EndpointSigningSecrets,
} from "./webhookSigning.js";
import {
  currentSealPrefix,
  openRowSecret,
  sealRowSecret,
} from "./sealedSecrets.js";

/**
 * Both of an endpoint's secret columns are sealed under this one name, so a
 * rotation moves the current ciphertext to `previousSigningSecret` as it is.
 */
export const endpointSecretName = (endpointId: string): string =>
  `webhook-endpoint:${endpointId}`;

/** What the API shows in place of a secret. */
export const secretHint = (secret: string): string => secret.slice(0, 8);

export interface NewEndpointSecret {
  plaintext: string;
  sealed: string;
  hint: string;
}

/** A fresh secret, or `plaintext` when given, sealed for the endpoint. */
export const newEndpointSecret = async (
  endpointId: string,
  plaintext: string = randomBytes(32).toString("hex")
): Promise<NewEndpointSecret> => ({
  plaintext,
  sealed: await sealRowSecret(endpointSecretName(endpointId), plaintext),
  hint: secretHint(plaintext),
});

type StoredSecrets = EndpointSigningSecrets & { id: string };

/** Opens one column, writing it back resealed while it still holds `stored`. */
const openColumn = async (
  endpointId: string,
  column: "signingSecret" | "previousSigningSecret",
  stored: string
): Promise<string> => {
  const { value, resealed } = await openRowSecret(
    endpointSecretName(endpointId),
    stored
  );
  if (resealed !== null) {
    // Conditional: a rotation meanwhile wins. A reseal is not an edit, so
    // updatedAt stays.
    await (column === "signingSecret"
      ? prisma.$executeRaw`
          UPDATE "webhooks"."webhook_endpoints"
          SET "signing_secret" = ${resealed},
              "signing_secret_hint" = COALESCE("signing_secret_hint", ${secretHint(value)})
          WHERE "id" = ${endpointId}::uuid AND "signing_secret" = ${stored}`
      : prisma.$executeRaw`
          UPDATE "webhooks"."webhook_endpoints"
          SET "previous_signing_secret" = ${resealed}
          WHERE "id" = ${endpointId}::uuid AND "previous_signing_secret" = ${stored}`);
  }
  return value;
};

/**
 * The endpoint's signing secrets in the clear, for signing a delivery. The
 * previous secret is opened only while it still signs. A value stored in
 * plaintext or under an older KEK is written back sealed under the current one.
 */
export const openEndpointSecrets = async (
  endpoint: StoredSecrets,
  now: Date = new Date()
): Promise<EndpointSigningSecrets> => {
  const signingSecret = await openColumn(
    endpoint.id,
    "signingSecret",
    endpoint.signingSecret
  );
  const previousSecretExpiresAt = previousSecretExpiry(endpoint, now);
  const previousSigningSecret = previousSecretExpiresAt
    ? await openColumn(
        endpoint.id,
        "previousSigningSecret",
        endpoint.previousSigningSecret!
      )
    : null;
  return { signingSecret, previousSigningSecret, previousSecretExpiresAt };
};

const SEAL_PAGE_SIZE = 100;

/**
 * Seals every endpoint secret not yet sealed under the current KEK: plaintext
 * rows from before sealing, and rows under the dev or previous KEK. Each write
 * applies only while the row still holds what was read, so replicas starting
 * together are safe; once done it finds nothing. A row that cannot be opened
 * is logged and left for its deliveries to fail on. A previous secret past
 * its overlap signs nothing any more, so it is cleared rather than sealed:
 * no plaintext (or old-KEK) copy of it is left behind.
 */
export const sealWebhookSecrets = async (): Promise<number> => {
  // Not an edit, so updatedAt stays.
  const cleared = await prisma.$executeRaw`
    UPDATE "webhooks"."webhook_endpoints"
    SET "previous_signing_secret" = NULL, "previous_secret_expires_at" = NULL
    WHERE "previous_signing_secret" IS NOT NULL
      AND ("previous_secret_expires_at" IS NULL
        OR "previous_secret_expires_at" <= now())`;
  if (cleared > 0) {
    logger.info(
      { endpoints: cleared },
      "Cleared expired previous webhook signing secrets"
    );
  }

  const prefix = `${currentSealPrefix()}%`;
  let sealed = 0;
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows = await prisma.$queryRaw<StoredSecrets[]>`
      SELECT "id"::text AS "id",
             "signing_secret" AS "signingSecret",
             "previous_signing_secret" AS "previousSigningSecret",
             "previous_secret_expires_at" AS "previousSecretExpiresAt"
      FROM "webhooks"."webhook_endpoints"
      WHERE "id" > ${after}::uuid
        AND ("signing_secret" NOT LIKE ${prefix}
          OR ("previous_signing_secret" NOT LIKE ${prefix}
            AND "previous_secret_expires_at" > now()))
      ORDER BY "id"
      LIMIT ${SEAL_PAGE_SIZE}`;
    for (const row of rows) {
      try {
        await openEndpointSecrets(row);
        sealed++;
      } catch (err) {
        logger.error(
          { err, endpointId: row.id },
          "Could not seal a webhook endpoint's signing secret"
        );
      }
    }
    if (rows.length < SEAL_PAGE_SIZE) break;
    after = rows[rows.length - 1].id;
  }
  if (sealed > 0) {
    logger.info(
      { endpoints: sealed },
      "Sealed webhook signing secrets under the KEK"
    );
  }
  return sealed;
};
