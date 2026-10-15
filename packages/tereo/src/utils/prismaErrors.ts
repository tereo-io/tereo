import { ConflictError } from "./errors.js";

/**
 * True if `err` is a foreign-key/restrict violation: a delete blocked because
 * other rows still reference the record, or a write naming a row that does
 * not exist. Detected by code, not `instanceof`: the Prisma error class
 * differs between generated clients.
 *
 * Several shapes occur in practice: Prisma's mapped `P2003`; the raw
 * `DriverAdapterError` from the pg driver adapter; and a Prisma error wrapping
 * that adapter error in `meta.driverAdapterError` (`P2039` from the client,
 * `P2010` from raw SQL). The adapter carries the Postgres SQLSTATE as
 * `originalCode` (and, for errors it does not classify, also as `code`):
 * `23001` (restrict_violation, raised by `ON DELETE RESTRICT`) or `23503`
 * (foreign_key_violation), neither of which Prisma maps to `P2003`.
 */
export function isForeignKeyConstraintError(err: unknown): boolean {
  const codes = pgErrorCodes(err);
  return ["P2003", "23001", "23503"].some((c) => codes.includes(c));
}

/**
 * Re-throw helper for hard-delete endpoints: if `err` is a Prisma `P2003`
 * (the row is still referenced by others under a Restrict relation) it
 * becomes a `ConflictError` (HTTP 409); anything else is rethrown unchanged.
 * Lets the DB relation be the source of truth for "in use".
 *
 * @example
 * try {
 *   await prisma.brand.delete({ where: { id } });
 * } catch (err) {
 *   rethrowRestrictedAsConflict(err, "Brand is still referenced by products");
 * }
 */
export function rethrowRestrictedAsConflict(
  err: unknown,
  message: string
): never {
  if (isForeignKeyConstraintError(err)) {
    throw new ConflictError(message);
  }
  throw err;
}

/**
 * True if `err` is a unique-constraint violation: `P2002`, or SQLSTATE `23505`
 * from the driver adapter in any of the shapes above.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  const codes = pgErrorCodes(err);
  return codes.includes("P2002") || codes.includes("23505");
}

/** Runs `fn`; a unique violation becomes `ConflictError(message, code)`, anything else is rethrown. */
export async function mapUniqueViolation<T>(
  fn: () => Promise<T>,
  message: string,
  code: string
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ConflictError(message, code);
    throw err;
  }
}

/**
 * The columns of the unique constraint `err` violated, or null when it is not
 * a unique violation. Through the pg driver adapter, Prisma's `P2002` names
 * them in `meta.driverAdapterError.cause.constraint.fields`, not `meta.target`.
 * Since Prisma 7.10 the adapter names only the index; its columns come back as
 * one name, the index's minus the table prefix and `_key` suffix
 * (`user_identities_user_id_provider_id_key` → `user_id_provider_id`), since
 * column names hold underscores too.
 */
export function uniqueViolationFields(err: unknown): string[] | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as {
    code?: unknown;
    meta?: {
      target?: unknown;
      driverAdapterError?: { cause?: AdapterCause };
    };
    cause?: AdapterCause;
  };
  const cause = e.meta?.driverAdapterError?.cause ?? e.cause;
  const isUnique =
    e.code === "P2002" ||
    cause?.kind === "UniqueConstraintViolation" ||
    cause?.originalCode === "23505";
  if (!isUnique) return null;
  const fields = cause?.constraint?.fields ?? e.meta?.target;
  if (Array.isArray(fields)) return fields.map(String);
  const index = cause?.constraint?.index;
  if (typeof index === "string") {
    const prefix = typeof cause?.table === "string" ? `${cause.table}_` : "";
    const columns = index.startsWith(prefix)
      ? index.slice(prefix.length)
      : index;
    return [columns.replace(/_key$/, "")];
  }
  if (typeof fields === "string") return [fields];
  return [];
}

interface AdapterCause {
  kind?: unknown;
  originalCode?: unknown;
  constraint?: { fields?: unknown; index?: unknown };
  table?: unknown;
}

/**
 * Every Postgres SQLSTATE or Prisma code found on `err`, its cause chain and
 * the driver adapter error Prisma wraps, which nest differently by version.
 */
export const pgErrorCodes = (err: unknown): string[] => {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  const walk = (e: unknown) => {
    if (!e || typeof e !== "object" || seen.has(e)) return;
    seen.add(e);
    const o = e as Record<string, unknown>;
    for (const key of ["code", "originalCode"]) {
      if (typeof o[key] === "string") codes.push(o[key] as string);
    }
    for (const key of ["cause", "meta", "driverAdapterError"]) {
      walk(o[key]);
    }
  };
  walk(err);
  return codes;
};
