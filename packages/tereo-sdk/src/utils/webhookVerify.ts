import type { Request, Response, NextFunction } from "express";
import { createHmac, timingSafeEqual } from "crypto";

const MAX_TIMESTAMP_AGE_SECONDS = 300; // 5 minutes

/**
 * The body exactly as core sent it: `req.rawBody` (set by a `verify` hook on
 * `express.json`), or the body itself under `express.raw()` / `express.text()`.
 * Re-serializing a parsed body is the last resort: it differs from what core
 * signed whenever JSON.parse reorders keys (integer-like ones), rewrites
 * numbers or drops escapes.
 */
function rawBodyOf(req: Request): string {
  const raw = (req as Request & { rawBody?: unknown }).rawBody;
  if (Buffer.isBuffer(raw)) return raw.toString("utf-8");
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf-8");
  if (typeof req.body === "string") return req.body;
  return JSON.stringify(req.body);
}

/**
 * Express middleware verifying core's webhook signatures.
 *
 * `X-Webhook-Signature` is `sha256=<hex HMAC-SHA256(secret, "${timestamp}.${body}")>`
 * over the raw request body; while an endpoint's rotated-out secret still
 * signs, it lists one such value per secret, comma-separated, and any match is
 * accepted. `X-Webhook-Timestamp` (Unix seconds) must be within 5 minutes of
 * now.
 *
 * Give it the raw body: mount it after
 * `express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })`, or
 * after `express.raw({ type: "application/json" })`.
 *
 * @param getSecret - Returns the signing secret, or undefined if not configured.
 */
export function createWebhookVerifier(
  getSecret: () => string | undefined
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    const secret = getSecret();
    if (!secret) {
      res.status(403).json({ error: "Webhook signing secret not configured" });
      return;
    }

    const signatureHeader = req.headers["x-webhook-signature"] as
      string | undefined;
    const timestampHeader = req.headers["x-webhook-timestamp"] as
      string | undefined;

    if (!signatureHeader || !timestampHeader) {
      res.status(401).json({ error: "Missing webhook signature headers" });
      return;
    }

    // Validate timestamp to prevent replay attacks
    const timestamp = Number(timestampHeader);
    if (!/^\d+$/.test(timestampHeader)) {
      res.status(401).json({ error: "Invalid webhook timestamp" });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > MAX_TIMESTAMP_AGE_SECONDS) {
      res.status(401).json({ error: "Webhook timestamp too old" });
      return;
    }

    const signatureInput = `${timestampHeader}.${rawBodyOf(req)}`;
    const expected = Buffer.from(
      `sha256=${createHmac("sha256", secret).update(signatureInput).digest("hex")}`,
      "utf-8"
    );

    // While core overlaps a rotated secret it sends one signature per secret.
    const matches = signatureHeader.split(",").some((candidate) => {
      const received = Buffer.from(candidate.trim(), "utf-8");
      return (
        received.length === expected.length &&
        timingSafeEqual(expected, received)
      );
    });
    if (!matches) {
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }

    next();
  };
}
