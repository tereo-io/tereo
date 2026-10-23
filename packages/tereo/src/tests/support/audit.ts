import { getTestPrincipalToken } from "./principals.js";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "./coreUrl.js";
import { randomBytes } from "crypto";

export const BASE_URL = `${CORE_URL}/v1/audit`;

// HTTP Status Code Constants for consistent test assertions
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
} as const;

export function generateUniqueId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * A real access token for a test user holding `audit-logs.admin`, scoped to
 * `orgId`. See `support/principals.ts`.
 */
export function getTestAccessToken(
  userId: string = "00000000-0000-7001-8000-000000000001",
  orgId: string | null = "00000000-0000-7002-8000-000000000001"
): Promise<string> {
  return getTestPrincipalToken({
    userId,
    organizationId: orgId,
    permissions: ["audit-logs.admin"],
  });
}

export function getTestUserId(): string {
  return "00000000-0000-7001-8000-000000000001";
}

export function getTestOrgId(): string {
  return "00000000-0000-7002-8000-000000000001";
}

// =============================================================================
// CLEANUP FUNCTIONS
// =============================================================================

/**
 * Cleanup test audit log entries
 */
export async function cleanupTestEntities() {
  await prisma.auditLogEntry
    .deleteMany({
      // userId is a UUID column — match by userEmail prefix instead.
      where: { userEmail: { startsWith: "test-" } },
    })
    .catch(() => {});
}

/**
 * Global cleanup for all test entities
 */
export async function cleanupAllTestEntities() {
  await prisma.auditLogEntry
    .deleteMany({
      // userId is a UUID column — match by userEmail prefix instead.
      where: { userEmail: { startsWith: "test-" } },
    })
    .catch(() => {});
}
