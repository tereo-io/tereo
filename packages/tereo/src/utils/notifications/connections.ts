import type { NotificationConnection } from "../../../prisma/generated/client/index.js";
import type { ConnectionView } from "./channels/types.js";
import { openRowSecret } from "../sealedSecrets.js";
import { getAdapter } from "./channels/index.js";
import { BadRequestError } from "../errors.js";
import { prisma } from "../db/prisma.js";

export const connectionSecretName = (id: string) =>
  `notification-connection:${id}`;

/**
 * The connection as an adapter sees it: settings only, parsed. Settings that
 * no longer parse (stored before a rule tightened, such as plaintext SMTP
 * once ALLOW_PLAINTEXT_SMTP is off) are a 400, and a delivery through them fails at once rather
 * than retrying.
 */
export const toConnectionView = (
  connection: NotificationConnection
): ConnectionView<unknown> => {
  const settings = getAdapter(connection.channel).settingsSchema.safeParse(
    connection.settings
  );
  if (!settings.success) {
    throw new BadRequestError(
      "invalid_settings",
      `Connection ${connection.slug}'s settings are no longer valid: ${settings.error.issues
        .map((i) => i.message)
        .join("; ")}`
    );
  }
  return {
    id: connection.id,
    slug: connection.slug,
    channel: connection.channel,
    settings: settings.data,
  };
};

/**
 * The connection's secrets, opened and parsed by its adapter. A value sealed
 * under the previous KEK is written back under the current one.
 */
export const openConnectionSecrets = async (
  connection: NotificationConnection
): Promise<unknown> => {
  const adapter = getAdapter(connection.channel);
  if (connection.secrets === null) return adapter.secretsSchema.parse({});
  const { value, resealed } = await openRowSecret(
    connectionSecretName(connection.id),
    connection.secrets
  );
  if (resealed !== null) {
    // Only while the row still holds what was read: a concurrent edit wins.
    // A reseal is not an edit, so updatedAt stays.
    await prisma.$executeRaw`
      UPDATE "notifications"."connections"
      SET "secrets" = ${resealed}
      WHERE "id" = ${connection.id}::uuid AND "secrets" = ${connection.secrets}`;
  }
  return adapter.secretsSchema.parse(JSON.parse(value));
};
