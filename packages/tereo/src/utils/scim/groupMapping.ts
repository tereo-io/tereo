import type { Group } from "../../../prisma/generated/client/index.js";
import type { ScimGroupLink } from "../db/scimGroups.js";
import { BadRequestError } from "../errors.js";
import { EXTERNAL_ID_MAX } from "./mapping.js";
import { GROUP_SCHEMA } from "./resources.js";
import { z } from "zod";

export { GROUP_SCHEMA };

export const DISPLAY_NAME_MAX = 255;
export const MAX_GROUP_MEMBERS = 5000;
export const MAX_MEMBER_CHANGES = 1000;

const SLUG_MAX = 100;

export const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ScimGroupInput {
  displayName: string;
  externalId: string | null;
  members: string[];
}

export const ScimGroupBodySchema = z.object({
  displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX),
  externalId: z.string().max(EXTERNAL_ID_MAX).nullish(),
  members: z.array(z.object({ value: z.unknown() })).nullish(),
});

/** Member values as sent, deduplicated in first-seen order. */
export const memberValues = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) {
    throw new BadRequestError("invalidValue", "members must be a list");
  }
  const seen = new Set<string>();
  for (const item of raw) {
    const value =
      typeof item === "object" && item !== null
        ? (item as { value?: unknown }).value
        : undefined;
    if (typeof value !== "string" || value === "") {
      throw new BadRequestError(
        "invalidValue",
        "Each member needs a string value"
      );
    }
    seen.add(value);
  }
  return [...seen];
};

export const toGroupInput = (
  body: z.infer<typeof ScimGroupBodySchema>
): ScimGroupInput => ({
  displayName: body.displayName,
  externalId: body.externalId?.trim() ? body.externalId : null,
  members: memberValues(body.members ?? []),
});

export const slugFromDisplayName = (displayName: string): string => {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug === "" ? "group" : slug;
};

export const withSlugSuffix = (base: string, n: number): string => {
  const suffix = `-${n}`;
  return `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
};

export const toScimGroup = (
  view: {
    link: ScimGroupLink;
    group: Group;
    members?: Array<{ id: string; name: string | null }>;
  },
  baseUrl: string
): Record<string, unknown> => ({
  schemas: [GROUP_SCHEMA],
  id: view.group.id,
  ...(view.link.externalId && { externalId: view.link.externalId }),
  displayName: view.group.name,
  ...(view.members && {
    members: view.members.map((m) => ({
      value: m.id,
      display: m.name,
      $ref: `${baseUrl}/Users/${m.id}`,
    })),
  }),
  meta: {
    resourceType: "Group",
    created: view.group.createdAt.toISOString(),
    // Membership changes move the link's timestamp, not the group's.
    lastModified: new Date(
      Math.max(view.group.updatedAt.getTime(), view.link.updatedAt.getTime())
    ).toISOString(),
    location: `${baseUrl}/Groups/${view.group.id}`,
  },
});
