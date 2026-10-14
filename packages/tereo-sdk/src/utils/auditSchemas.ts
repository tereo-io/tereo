import type { AuditLogEntryInput } from "../types/audit.js";
import { isIP } from "node:net";
import { z } from "zod";

/**
 * Zod schema for client-side entry validation.
 * Mirrors the service's entryFieldsSchema to fail fast before network/queue.
 */
const auditLogEntrySchema = z.object({
  userId: z.string().uuid("userId must be a UUID"),
  action: z.enum(["CREATE", "UPDATE", "DELETE", "MERGE", "ARCHIVE", "RESTORE"]),
  entityType: z
    .string()
    .min(1, "entityType is required and must not be empty")
    .max(100, "entityType exceeds maximum length of 100 characters"),
  entityId: z
    .string()
    .min(1, "entityId is required and must not be empty")
    .max(500, "entityId must be at most 500 characters"),
  entityName: z
    .string()
    .max(500, "entityName exceeds maximum length of 500 characters")
    .optional(),
  organizationId: z.string().uuid("organizationId must be a UUID").nullish(),
  // Core validates with the same `z.string().email()`; an empty string is sent as null.
  userEmail: z
    .union([z.literal(""), z.string().email("Invalid email format")])
    .nullish(),
  ipAddress: z
    .string()
    .refine((val) => val === "" || isIP(val) !== 0, "Invalid IP address")
    .nullish(),
  correlationId: z
    .string()
    .max(255, "correlationId exceeds maximum length of 255 characters")
    .optional(),
  idempotencyKey: z
    .string()
    .min(1, "idempotencyKey must not be empty when provided")
    .max(255, "idempotencyKey exceeds maximum length of 255 characters")
    .optional(),
  changes: z
    .record(
      z.string(),
      z.object({ old: z.unknown().optional(), new: z.unknown().optional() })
    )
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// Postgres stores neither a NUL in text nor a \u0000 escape in jsonb; core
// refuses either with a 400.
const hasNul = (value: unknown): boolean => {
  if (typeof value === "string") return value.includes("\0");
  if (Array.isArray(value)) return value.some(hasNul);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([k, v]) => hasNul(k) || hasNul(v));
  }
  return false;
};

/** An entry core would refuse with a 400, so sending it again cannot help. */
export class InvalidAuditEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAuditEntryError";
  }
}

/**
 * Validate entry fields that would cause a 400 from the service.
 * Throws on invalid input to fail fast instead of consuming outbox retries.
 */
export function validateEntry(entry: AuditLogEntryInput): void {
  const result = auditLogEntrySchema.safeParse(entry);
  if (!result.success) {
    throw new InvalidAuditEntryError(result.error.issues[0].message);
  }
  if (hasNul(entry)) {
    throw new InvalidAuditEntryError(
      "Audit entry must not contain a NUL character"
    );
  }
}
