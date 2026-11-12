import { BadRequestError } from "../errors.js";

export type ScimUserFilterAttr = "userName" | "externalId" | "email";
export type ScimGroupFilterAttr = "displayName" | "externalId";
export type ScimFilterAttr = ScimUserFilterAttr | ScimGroupFilterAttr;
export type ScimFilter = Array<{ attr: ScimUserFilterAttr; value: string }>;
export type ScimGroupFilter = Array<{
  attr: ScimGroupFilterAttr;
  value: string;
}>;

const MAX_FILTER_LENGTH = 2000;

const USER_ATTR =
  /(userName|externalId|emails\.value|emails\[\s*type\s+eq\s+"[^"\\]*"\s*\]\.value)/iy;
const GROUP_ATTR = /(displayName|externalId)/iy;
const EQ = /\s+eq\s+/iy;
const QUOTED = /"((?:[^"\\]|\\.)*)"/y;
const AND = /\s+and\s+/iy;

const invalid = (detail: string) =>
  new BadRequestError("invalidFilter", detail);

const attrOf = (token: string): ScimFilterAttr => {
  const lower = token.toLowerCase();
  if (lower === "username") return "userName";
  if (lower === "externalid") return "externalId";
  if (lower === "displayname") return "displayName";
  return "email";
};

const match = (re: RegExp, s: string, at: number): RegExpExecArray | null => {
  re.lastIndex = at;
  return re.exec(s);
};

export function parseFilter(
  raw: string | undefined,
  resource?: "User"
): ScimFilter;
export function parseFilter(
  raw: string | undefined,
  resource: "Group"
): ScimGroupFilter;
export function parseFilter(
  raw: string | undefined,
  resource: "User" | "Group" = "User"
): ScimFilter | ScimGroupFilter {
  const ATTR = resource === "Group" ? GROUP_ATTR : USER_ATTR;
  if (raw === undefined) return [];
  if (raw.length > MAX_FILTER_LENGTH) throw invalid("Filter is too long");
  const s = raw.trim();
  if (s === "") throw invalid("Filter is empty");

  const clauses: Array<{ attr: ScimFilterAttr; value: string }> = [];
  let pos = 0;
  for (;;) {
    const attr = match(ATTR, s, pos);
    if (!attr) {
      throw invalid(
        resource === "Group"
          ? "Only displayName and externalId are filterable"
          : "Only userName, externalId and emails.value are filterable"
      );
    }
    pos = ATTR.lastIndex;
    if (!match(EQ, s, pos)) throw invalid("Only the eq operator is supported");
    pos = EQ.lastIndex;
    const quoted = match(QUOTED, s, pos);
    if (!quoted) throw invalid("A filter value must be a quoted string");
    pos = QUOTED.lastIndex;

    let value: string;
    try {
      value = JSON.parse(`"${quoted[1]}"`) as string;
    } catch {
      throw invalid("Invalid escape in filter value");
    }
    clauses.push({ attr: attrOf(attr[1]), value });

    if (pos === s.length) return clauses as ScimFilter | ScimGroupFilter;
    if (!match(AND, s, pos)) {
      throw invalid("Clauses can only be joined with and");
    }
    pos = AND.lastIndex;
  }
}
