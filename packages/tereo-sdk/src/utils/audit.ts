/**
 * Deep equality comparison for computing field-level diffs.
 * Handles primitives, Date objects, arrays, and nested plain objects.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
      if (!deepEqual(aObj[key], bObj[key])) return false;
    }
    return true;
  }

  return false;
}

/**
 * Compute field-level diffs between old and new objects.
 * Skips `createdAt`, `updatedAt`, `deletedAt`, `archivedAt` fields.
 * Returns `undefined` if no changes detected.
 */
export function computeChanges(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>
): Record<string, { old: unknown; new: unknown }> | undefined {
  const changes: Record<string, { old: unknown; new: unknown }> = {};

  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

  for (const key of allKeys) {
    if (["createdAt", "updatedAt", "deletedAt", "archivedAt"].includes(key))
      continue;

    const oldVal = oldObj[key];
    const newVal = newObj[key];

    if (!deepEqual(oldVal, newVal)) {
      changes[key] = { old: oldVal, new: newVal };
    }
  }

  return Object.keys(changes).length > 0 ? changes : undefined;
}
