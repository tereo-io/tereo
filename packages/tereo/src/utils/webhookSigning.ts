import { createHmac } from "crypto";

export interface EndpointSigningSecrets {
  signingSecret: string;
  previousSigningSecret: string | null;
  previousSecretExpiresAt: Date | null;
}

/** When the previous secret stops signing, or null if it no longer does. */
export const previousSecretExpiry = (
  endpoint: EndpointSigningSecrets,
  now: Date = new Date()
): Date | null =>
  endpoint.previousSigningSecret &&
  endpoint.previousSecretExpiresAt &&
  endpoint.previousSecretExpiresAt > now
    ? endpoint.previousSecretExpiresAt
    : null;

/**
 * The `X-Webhook-Signature` value: `sha256=<hex>` for the current secret, then
 * `,sha256=<hex>` for the previous one while its overlap lasts.
 */
export const signatureHeader = (
  endpoint: EndpointSigningSecrets,
  timestamp: number,
  body: string,
  now: Date = new Date()
): string => {
  const secrets = [endpoint.signingSecret];
  if (previousSecretExpiry(endpoint, now)) {
    secrets.push(endpoint.previousSigningSecret!);
  }
  return secrets
    .map(
      (secret) =>
        `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`
    )
    .join(",");
};
