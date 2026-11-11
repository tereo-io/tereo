import { LIST_RESPONSE_SCHEMA, USER_SCHEMA } from "./resources.js";
import type { UserRow } from "../userLifecycle.js";
import type { ScimUserLink } from "../db/scim.js";
import { normalizeEmail } from "../email.js";
import { z } from "zod";

export interface ScimUserInput {
  userName?: string;
  externalId?: string | null;
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  active?: boolean;
}

export const NAME_MAX = 100;
export const USER_NAME_MAX = 255;
export const EXTERNAL_ID_MAX = 255;
export const EMAIL_MAX = 255;

const BOOLEAN_STRING = /^(true|false)$/i;

/** Okta sends booleans, Entra sends "True" / "False". */
export const parseScimBoolean = (v: unknown): boolean | undefined => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && BOOLEAN_STRING.test(v.trim())) {
    return v.trim().toLowerCase() === "true";
  }
  return undefined;
};

const emailShape = z.string().email();

/** The address as core stores it, or undefined when `value` is not an email. */
export const toCoreEmail = (value: string): string | undefined => {
  const email = normalizeEmail(value);
  if (email.length > EMAIL_MAX || !emailShape.safeParse(email).success) {
    return undefined;
  }
  return email;
};

const text = (max: number) => z.string().max(max);

export const ScimUserObjectSchema = z.object({
  userName: text(USER_NAME_MAX).min(1),
  externalId: text(EXTERNAL_ID_MAX).nullish(),
  name: z
    .object({
      givenName: text(NAME_MAX).nullish(),
      familyName: text(NAME_MAX).nullish(),
      formatted: text(NAME_MAX).nullish(),
    })
    .nullish(),
  displayName: text(NAME_MAX).nullish(),
  emails: z
    .array(
      z.object({
        value: z.string(),
        type: z.string().nullish(),
        primary: z.union([z.boolean(), z.string()]).nullish(),
      })
    )
    .nullish(),
  active: z
    .union([
      z.boolean(),
      z.string().refine((s) => BOOLEAN_STRING.test(s.trim()), "Not a boolean"),
    ])
    .nullish(),
});

type Body = z.infer<typeof ScimUserObjectSchema>;

const nonEmpty = (s: string | null | undefined): string | undefined =>
  s && s.trim() !== "" ? s : undefined;

const resolveEmailValue = (body: Body): string | undefined => {
  const emails = body.emails ?? [];
  const primary =
    emails.find((e) => parseScimBoolean(e.primary) === true) ?? emails[0];
  if (primary) return primary.value;
  return body.userName;
};

const composedName = (body: Body): string | undefined => {
  const parts = [body.name?.givenName, body.name?.familyName]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(" ") : undefined;
};

const resolveName = (body: Body): string | undefined =>
  nonEmpty(body.displayName) ??
  nonEmpty(body.name?.formatted) ??
  composedName(body);

export const ScimUserBodySchema = ScimUserObjectSchema.superRefine(
  (body, ctx) => {
    const hasEmails = (body.emails ?? []).length > 0;
    const value = resolveEmailValue(body);
    if (value === undefined || toCoreEmail(value) === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["emails"],
        message: hasEmails
          ? "emails must hold a valid email address"
          : "emails is required when userName is not an email address",
      });
    }
    const name = resolveName(body);
    if (name !== undefined && name.length > NAME_MAX) {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message: `The name is longer than ${NAME_MAX} characters`,
      });
    }
  }
);

/** PUT semantics: a name attribute left out clears the stored value. */
export const toUserInput = (
  body: z.infer<typeof ScimUserBodySchema>
): ScimUserInput => {
  const active = parseScimBoolean(body.active);
  const emailValue = resolveEmailValue(body);
  return {
    userName: body.userName,
    externalId: nonEmpty(body.externalId) ?? null,
    ...(emailValue !== undefined && { email: toCoreEmail(emailValue) }),
    firstName: nonEmpty(body.name?.givenName) ?? null,
    lastName: nonEmpty(body.name?.familyName) ?? null,
    name: resolveName(body) ?? null,
    ...(active !== undefined && { active }),
  };
};

export const toScimUser = (
  user: UserRow,
  link: ScimUserLink,
  baseUrl: string
): Record<string, unknown> => ({
  schemas: [USER_SCHEMA],
  id: user.id,
  ...(link.externalId && { externalId: link.externalId }),
  userName: link.userName,
  name: {
    ...(user.name && { formatted: user.name }),
    ...(user.firstName && { givenName: user.firstName }),
    ...(user.lastName && { familyName: user.lastName }),
  },
  ...(user.name && { displayName: user.name }),
  emails: [{ value: user.email, type: "work", primary: true }],
  active: user.isActive,
  meta: {
    resourceType: "User",
    created: user.createdAt.toISOString(),
    lastModified: user.updatedAt.toISOString(),
    location: `${baseUrl}/Users/${user.id}`,
  },
});

export const listResponse = (
  resources: unknown[],
  total: number,
  startIndex: number
): Record<string, unknown> => ({
  schemas: [LIST_RESPONSE_SCHEMA],
  totalResults: total,
  startIndex,
  itemsPerPage: resources.length,
  Resources: resources,
});
