import { openSecret, sealSecret, sealedPrefix } from "./kek.js";
import { currentKek, previousKek } from "./keys.js";
import env from "../env.js";

/**
 * Secrets kept in a table's own column (an identity provider's client secret,
 * a notification connection's password), sealed under the KEK like
 * `core.secrets`. `name` is bound to the ciphertext, so it should name the
 * row — `"notification-connection:<id>"` — and a value cannot be copied to
 * another row.
 */
export const sealRowSecret = (name: string, value: string): Promise<string> =>
  sealSecret(currentKek(), name, value);

/** How a value sealed under the current KEK starts; anything else needs sealing. */
export const currentSealPrefix = (): string => sealedPrefix(currentKek());

export interface OpenedRowSecret {
  value: string;
  /**
   * The value sealed under the current KEK, when it was stored under the
   * previous or the dev KEK: the caller writes it back. Otherwise null.
   */
  resealed: string | null;
}

export const openRowSecret = async (
  name: string,
  stored: string
): Promise<OpenedRowSecret> => {
  const { value, rewrap } = await openSecret(
    currentKek(),
    name,
    stored,
    previousKek,
    env.NODE_ENV === "production"
  );
  return {
    value,
    resealed: rewrap ? await sealSecret(currentKek(), name, value) : null,
  };
};
