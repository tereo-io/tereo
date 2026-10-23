import { generateUniqueId } from "./crypto.js";
import { BASE_URL } from "./constants.js";

export interface OrganizationResponse {
  id: string;
  name: string;
  slug: string;
  code: string;
  isDefault: boolean;
  isActive: boolean;
  archivedAt: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMemberResponse {
  id: string;
  memberRole: "owner" | "admin" | "member";
  createdAt: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    isActive: boolean;
  };
}

export interface OrganizationListResponse {
  data: OrganizationResponse[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

export interface OrganizationMembersResponse {
  organizationId: string;
  members: OrganizationMemberResponse[];
}

export interface MemberRolesResponse {
  organizationId: string;
  userId: string;
  roles: Array<{
    id: string;
    name: string;
    displayName: string | null;
    expiresAt: string | null;
  }>;
}

export async function createTestOrganization(
  adminToken: string,
  options: {
    name?: string;
    slug?: string;
    code?: string;
  } = {}
): Promise<OrganizationResponse> {
  const uniqueId = generateUniqueId();

  const response = await fetch(`${BASE_URL}/v1/admin/organizations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: options.name || `Test Org ${uniqueId}`,
      slug: options.slug || `test-org-${uniqueId}`,
      code: options.code || uniqueId.slice(0, 6).toUpperCase(),
    }),
  });

  if (response.status !== 201) {
    const data = await response.json();
    throw new Error(
      `Failed to create test organization: ${response.status} ${JSON.stringify(data)}`
    );
  }

  return response.json() as Promise<OrganizationResponse>;
}

export async function addTestOrgMember(
  adminToken: string,
  orgId: string,
  userId: string,
  memberRole: "owner" | "admin" | "member" = "member"
): Promise<OrganizationMemberResponse> {
  const response = await fetch(
    `${BASE_URL}/v1/admin/organizations/${orgId}/members`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId, memberRole }),
    }
  );

  if (response.status !== 201) {
    const data = await response.json();
    throw new Error(
      `Failed to add org member: ${response.status} ${JSON.stringify(data)}`
    );
  }

  return response.json() as Promise<OrganizationMemberResponse>;
}
