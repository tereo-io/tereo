// The system tenant every context-less event is attributed to. The id is a
// uuidv5 of "organization:default" in the platform namespace, kept literal so
// existing rows still match.
export const DEFAULT_ORGANIZATION = {
  id: "a22161a6-8700-56d4-855c-093b3a7e71c2",
  name: "Default",
  slug: "default",
  code: "DFLT",
} as const;

export const DEFAULT_ORGANIZATION_ID = DEFAULT_ORGANIZATION.id;
