/**
 * Test files and helpers not yet in the new layout, by path under
 * `src/tests`. Each area task removes its entries; the file is deleted once
 * this is empty.
 */
export const LEGACY_PATHS: readonly string[] = [
  "auth/account.test.ts",
  "auth/accountOrganizations.test.ts",
  "auth/admin-clients.test.ts",
  "auth/admin-credential-resets.test.ts",
  "auth/admin-guard.test.ts",
  "auth/admin-identity-providers.test.ts",
  "auth/admin-organizations.test.ts",
  "auth/admin-permissions.test.ts",
  "auth/admin-roles.test.ts",
  "auth/admin-settings.test.ts",
  "auth/admin-users.test.ts",
  "auth/archiveReactivateRaces.test.ts",
  "auth/audit-login-logout.test.ts",
  "auth/checkPermissionOrg.test.ts",
  "auth/credentialFailureLimits.test.ts",
  "auth/embeddedRefs.test.ts",
  "auth/permission-scope.test.ts",
  "auth/roleAssignmentRaces.test.ts",
  "auth/roleDeletedDuringAssignment.test.ts",
  "auth/supportAccess.test.ts",
  "support/auth.ts",
];
