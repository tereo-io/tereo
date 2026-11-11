import { BadRequestError } from "../errors.js";
import { z } from "zod";
import {
  EMAIL_MAX,
  EXTERNAL_ID_MAX,
  NAME_MAX,
  parseScimBoolean,
  toCoreEmail,
  USER_NAME_MAX,
  type ScimUserInput,
} from "./mapping.js";

export const ScimPatchBodySchema = z.object({
  Operations: z
    .array(
      z.object({
        op: z.string(),
        path: z.string().optional(),
        value: z.unknown().optional(),
      })
    )
    .min(1),
});

const OPS = new Set(["add", "replace", "remove"]);

const invalidValue = (detail: string) =>
  new BadRequestError("invalidValue", detail);

const EMAILS_PATH = /^emails(?:\[[^\]]*\])?(?:\.value)?$/i;
const SCHEMA_PREFIX = /^urn:[^\s]*:User:/i;

const str = (v: unknown, attr: string, max: number): string => {
  if (typeof v !== "string") throw invalidValue(`${attr} must be a string`);
  if (v.length > max) {
    throw invalidValue(`${attr} is longer than ${max} characters`);
  }
  return v;
};

const nullableStr = (v: unknown, attr: string, max: number) =>
  v === null || v === "" ? null : str(v, attr, max);

const emailFrom = (v: unknown): string => {
  const raw = Array.isArray(v) ? pickEmail(v) : v;
  if (typeof raw !== "string")
    throw invalidValue("emails must hold an address");
  const email = toCoreEmail(raw);
  if (email === undefined || email.length > EMAIL_MAX) {
    throw invalidValue("emails must hold a valid email address");
  }
  return email;
};

const pickEmail = (list: unknown[]): unknown => {
  const items = list.filter(
    (e): e is { value?: unknown; primary?: unknown } =>
      typeof e === "object" && e !== null
  );
  const chosen =
    items.find((e) => parseScimBoolean(e.primary) === true) ?? items[0];
  return chosen?.value;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const applyValue = (
  out: ScimUserInput,
  rawPath: string,
  value: unknown
): void => {
  const path = rawPath.trim().replace(SCHEMA_PREFIX, "");
  const lower = path.toLowerCase();

  if (EMAILS_PATH.test(path)) {
    out.email = emailFrom(value);
    return;
  }
  switch (lower) {
    case "username":
      out.userName = str(value, "userName", USER_NAME_MAX);
      if (out.userName.trim() === "") {
        throw invalidValue("userName must not be empty");
      }
      return;
    case "externalid":
      out.externalId = nullableStr(value, "externalId", EXTERNAL_ID_MAX);
      return;
    case "active": {
      const active = parseScimBoolean(value);
      if (active === undefined) throw invalidValue("active must be a boolean");
      out.active = active;
      return;
    }
    case "displayname":
    case "name.formatted":
      out.name = nullableStr(value, lower, NAME_MAX);
      return;
    case "name.givenname":
      out.firstName = nullableStr(value, "name.givenName", NAME_MAX);
      return;
    case "name.familyname":
      out.lastName = nullableStr(value, "name.familyName", NAME_MAX);
      return;
    case "name":
      if (!isObject(value)) throw invalidValue("name must be an object");
      for (const [k, v] of Object.entries(value)) {
        applyValue(out, `name.${k}`, v);
      }
      return;
    default:
  }
};

const applyRemove = (out: ScimUserInput, rawPath: string): void => {
  const path = rawPath.trim().replace(SCHEMA_PREFIX, "");
  const lower = path.toLowerCase();
  if (EMAILS_PATH.test(path) || lower === "username" || lower === "active") {
    throw invalidValue(`${path} cannot be removed`);
  }
  switch (lower) {
    case "externalid":
      out.externalId = null;
      return;
    case "displayname":
    case "name.formatted":
      out.name = null;
      return;
    case "name.givenname":
      out.firstName = null;
      return;
    case "name.familyname":
      out.lastName = null;
      return;
    case "name":
      out.firstName = null;
      out.lastName = null;
      out.name = null;
      return;
    default:
  }
};

/** Only the keys the operations name are set; an unknown path is ignored. */
export const applyPatch = (
  body: z.infer<typeof ScimPatchBodySchema>
): ScimUserInput => {
  const out: ScimUserInput = {};
  for (const operation of body.Operations) {
    const op = operation.op.trim().toLowerCase();
    if (!OPS.has(op)) {
      throw new BadRequestError(
        "invalidSyntax",
        `Unsupported PATCH operation: ${operation.op}`
      );
    }
    if (operation.path === undefined || operation.path.trim() === "") {
      if (op === "remove") {
        throw new BadRequestError("invalidPath", "remove requires a path");
      }
      if (!isObject(operation.value)) {
        throw invalidValue("An operation without a path needs an object value");
      }
      for (const [k, v] of Object.entries(operation.value)) {
        applyValue(out, k, v);
      }
      continue;
    }
    if (op === "remove") applyRemove(out, operation.path);
    else applyValue(out, operation.path, operation.value);
  }
  return out;
};
