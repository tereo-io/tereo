import { createCursorQuerySchema } from "../../../../utils/parseQueryString.js";
import { emailSchema } from "../../../../utils/email.js";
import { passwordSchema } from "../users/schemas.js";
import env from "../../../../env.js";
import { z } from "zod";

const MAX_ROLES_PER_INVITE = 100;

/**
 * An RFC 3339 date-time. Not `z.coerce.date()`, which turns `null` into 1970
 * and so would end a guest's access on a missing value.
 */
export const expiresAtSchema = z.iso
  .datetime({ offset: true })
  .transform((s) => new Date(s));

const InitialAccessSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("password_setup_link"),
    notify: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("password"),
    password: passwordSchema,
    mustChange: z.boolean().default(true),
  }),
]);

export const InviteGuestSchema = z
  .object({
    email: emailSchema,
    name: z.string().max(100).optional(),
    organizationId: z.guid().optional(),
    // Role names (custom roles) or ids.
    roles: z
      .array(z.string().min(1).max(100))
      .max(MAX_ROLES_PER_INVITE)
      .optional(),
    expiresAt: expiresAtSchema.optional(),
    expiresIn: z.number().int().min(1).optional(),
    initialAccess: InitialAccessSchema,
  })
  .superRefine((body, ctx) => {
    if ((body.expiresAt === undefined) === (body.expiresIn === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Give exactly one of expiresAt and expiresIn",
      });
      return;
    }
    const ttlMs =
      body.expiresIn !== undefined
        ? body.expiresIn * 1000
        : (body.expiresAt as Date).getTime() - Date.now();
    const path = [body.expiresIn !== undefined ? "expiresIn" : "expiresAt"];
    if (ttlMs <= 0) {
      ctx.addIssue({
        code: "custom",
        path,
        message: "The expiry must be in the future",
      });
    } else if (ttlMs > env.GUEST_MAX_TTL_SECONDS * 1000) {
      ctx.addIssue({
        code: "custom",
        path,
        message: `A guest may be invited for at most ${env.GUEST_MAX_TTL_SECONDS} seconds`,
      });
    }
  })
  .transform(({ expiresIn, expiresAt, ...rest }) => ({
    ...rest,
    expiresAt: expiresAt ?? new Date(Date.now() + (expiresIn as number) * 1000),
  }));

export type InviteGuestInput = z.infer<typeof InviteGuestSchema>;

export const ListGuestsQuerySchema = createCursorQuerySchema({
  filters: {
    organizationId: {
      operators: ["equals"],
      schema: z.guid(),
      toWhere: ({ equals }) => ({
        organizationMembers: { some: { organizationId: equals } },
      }),
    },
    // Stored emails are lower case.
    email: {
      operators: ["contains", "equals"],
      schema: z.string().trim().toLowerCase(),
    },
    isActive: { operators: ["equals"], schema: z.boolean() },
    expiresAt: { operators: ["gte", "lte"], schema: z.coerce.date() },
    createdAt: { operators: ["gte", "lte"], schema: z.coerce.date() },
  },
  sortFields: {
    id: "id",
    email: "email",
    createdAt: "createdAt",
    expiresAt: "expiresAt",
  },
  defaultSort: "id",
});
