import { ScimPatchBodySchema } from "./patch.js";
import { BadRequestError } from "../errors.js";
import { EXTERNAL_ID_MAX } from "./mapping.js";
import { z } from "zod";
import {
  DISPLAY_NAME_MAX,
  MAX_GROUP_MEMBERS,
  memberValues,
  UUID_SHAPE,
} from "./groupMapping.js";

export type GroupPatchOp =
  | { kind: "addMembers"; values: string[] }
  | { kind: "removeMembers"; values: string[] }
  | { kind: "clearMembers" }
  | { kind: "replaceMembers"; values: string[] }
  | { kind: "displayName"; value: string }
  | { kind: "externalId"; value: string | null };

type Verb = "add" | "replace" | "remove";

const VERBS = new Set<string>(["add", "replace", "remove"]);
const SCHEMA_PREFIX = /^urn:[^\s]*:Group:/i;
const MEMBER_SELECTOR = /^members\[\s*value\s+eq\s+"([^"\\]*)"\s*\]$/i;

const invalidValue = (detail: string) =>
  new BadRequestError("invalidValue", detail);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const members = (value: unknown): string[] => {
  if (Array.isArray(value) && value.length > MAX_GROUP_MEMBERS) {
    throw new BadRequestError(
      "tooMany",
      `A request may name at most ${MAX_GROUP_MEMBERS} members`
    );
  }
  return memberValues(value);
};

const displayName = (value: unknown): string => {
  if (typeof value !== "string") {
    throw invalidValue("displayName must be a string");
  }
  const name = value.trim();
  if (name === "" || name.length > DISPLAY_NAME_MAX) {
    throw invalidValue(
      `displayName must be 1 to ${DISPLAY_NAME_MAX} characters`
    );
  }
  return name;
};

// A blank value clears the attribute, as it does in a PUT body.
const externalId = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw invalidValue("externalId must be a string");
  }
  if (value.length > EXTERNAL_ID_MAX) {
    throw invalidValue(
      `externalId is longer than ${EXTERNAL_ID_MAX} characters`
    );
  }
  return value.trim() === "" ? null : value;
};

const applyValue = (verb: Verb, rawPath: string, value: unknown) => {
  const path = rawPath.trim().replace(SCHEMA_PREFIX, "");
  switch (path.toLowerCase()) {
    case "members": {
      const values = members(value);
      return verb === "add"
        ? ({ kind: "addMembers", values } as const)
        : ({ kind: "replaceMembers", values } as const);
    }
    case "displayname":
      return { kind: "displayName", value: displayName(value) } as const;
    case "externalid":
      return { kind: "externalId", value: externalId(value) } as const;
    default:
      throw new BadRequestError("invalidPath", `Unsupported path: ${rawPath}`);
  }
};

const applyRemove = (rawPath: string, value: unknown): GroupPatchOp => {
  const path = rawPath.trim().replace(SCHEMA_PREFIX, "");
  const selector = MEMBER_SELECTOR.exec(path);
  if (selector?.[1]) return { kind: "removeMembers", values: [selector[1]] };
  switch (path.toLowerCase()) {
    case "members":
      return value === undefined || value === null
        ? { kind: "clearMembers" }
        : { kind: "removeMembers", values: members(value) };
    case "externalid":
      return { kind: "externalId", value: null };
    case "displayname":
      throw invalidValue("displayName cannot be removed");
    default:
      throw new BadRequestError("invalidPath", `Unsupported path: ${rawPath}`);
  }
};

const NO_PATH_KEYS = new Set(["displayname", "externalid", "members"]);

/** One entry per change, in request order; the caller applies them in one transaction. */
export const normaliseGroupPatch = (
  body: z.infer<typeof ScimPatchBodySchema>
): GroupPatchOp[] => {
  const out: GroupPatchOp[] = [];
  for (const operation of body.Operations) {
    const op = operation.op.trim().toLowerCase();
    if (!VERBS.has(op)) {
      throw new BadRequestError(
        "invalidSyntax",
        `Unsupported PATCH operation: ${operation.op}`
      );
    }
    const verb = op as Verb;
    if (operation.path === undefined || operation.path.trim() === "") {
      if (verb === "remove") {
        throw new BadRequestError("invalidPath", "remove requires a path");
      }
      if (!isObject(operation.value)) {
        throw invalidValue("An operation without a path needs an object value");
      }
      for (const [k, v] of Object.entries(operation.value)) {
        const key = k.trim().replace(SCHEMA_PREFIX, "");
        if (NO_PATH_KEYS.has(key.toLowerCase())) {
          out.push(applyValue(verb, key, v));
        }
      }
      continue;
    }
    out.push(
      verb === "remove"
        ? applyRemove(operation.path, operation.value)
        : applyValue(verb, operation.path, operation.value)
    );
  }
  return out;
};

export interface GroupChangePlan {
  /** The member set the request leaves, as UUID-shaped ids. */
  desired: Set<string>;
  touchesMembers: boolean;
  displayName?: string;
  /** Undefined leaves it as it is. */
  externalId?: string | null;
}

const uuids = (values: string[]) =>
  values.filter((v) => UUID_SHAPE.test(v)).map((v) => v.toLowerCase());

/**
 * Runs the operations in order over the member set. The members the directory
 * pushed that were skipped earlier count as part of it whenever a request
 * touches members, so any member change retries them.
 */
export const resolveGroupOps = (
  ops: GroupPatchOp[],
  current: Iterable<string>,
  recorded: Iterable<string>
): GroupChangePlan => {
  const touchesMembers = ops.some(
    (op) => op.kind !== "displayName" && op.kind !== "externalId"
  );
  let desired = new Set(current);
  if (touchesMembers) for (const id of recorded) desired.add(id);
  const plan: GroupChangePlan = { desired, touchesMembers };
  for (const op of ops) {
    switch (op.kind) {
      case "addMembers":
        for (const id of uuids(op.values)) desired.add(id);
        break;
      case "removeMembers":
        for (const id of uuids(op.values)) desired.delete(id);
        break;
      case "clearMembers":
        desired.clear();
        break;
      case "replaceMembers":
        desired = new Set(uuids(op.values));
        break;
      case "displayName":
        plan.displayName = op.value;
        break;
      case "externalId":
        plan.externalId = op.value;
        break;
    }
  }
  plan.desired = desired;
  return plan;
};
