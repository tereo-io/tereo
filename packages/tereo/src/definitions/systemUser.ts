// The principal core acts as when no user is behind a write — lifecycle
// sweeps, and the writer of core's own audit entries. A service account with
// no password and no OAuth client, so nothing can log in or mint a token as
// it. Seeded; every actor column can reference it like any other user.
export const SYSTEM_USER = {
  id: "00000000-0000-7000-8000-000000000001",
  email: "system@tereo.internal",
  name: "tereo",
} as const;

export const SYSTEM_USER_ID = SYSTEM_USER.id;
