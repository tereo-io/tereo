import type { AuditAction, AuditLogActor, AuditLogEntry } from "../types";

export const actionVariant = (action: AuditAction | string) => {
  switch (action) {
    case "CREATE":
    case "RESTORE":
      return "success";
    case "UPDATE":
      return "warning";
    case "DELETE":
    case "ARCHIVE":
      return "danger";
    case "MERGE":
      return "primary";
    default:
      return "secondary";
  }
};

/** `bucketPermission` → `bucket Permission`; dotted/snake names left as-is. */
export const formatEntityType = (entityType: string) =>
  entityType.replace(/([a-z])([A-Z])/g, "$1 $2");

export const formatUser = (user: AuditLogActor) => user.name || user.email;

export const formatOrganization = (entry: AuditLogEntry) =>
  entry.organization?.name ?? "System-wide";

export const formatChangeValue = (value: unknown): string => {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
};

const timestampFormat = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Audit timestamps need seconds; the app-wide `formatDate` stops at minutes. */
export const formatTimestamp = (iso: string) =>
  timestampFormat.format(new Date(iso));
