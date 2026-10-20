import type { APIRequestContext, APIResponse } from "@playwright/test";
import { randomBytes, randomUUID } from "crypto";
import { e2e } from "../config.js";

export interface CreatedUser {
  id: string;
  email: string;
  name: string | null;
}

export interface CreatedRole {
  id: string;
  name: string;
  displayName: string;
}

export interface CreatedWebhookEndpoint {
  id: string;
  url: string;
}

export interface CreatedObject {
  id: string;
  key: string;
}

export interface CreatedOrganization {
  id: string;
  name: string;
  slug: string;
  code: string;
}

export type MemberRole = "owner" | "admin" | "member";

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** An organization code core accepts (1–6 of A–Z, 0–9) that no other spec has taken. */
export const orgCode = () =>
  Array.from(randomBytes(6), (b) => ALPHANUMERIC[b % ALPHANUMERIC.length]).join(
    ""
  );

/** A password core's rules accept. */
export const TEST_PASSWORD = "E2e-User-Passw0rd!";

async function json<T>(response: APIResponse): Promise<T> {
  if (!response.ok()) {
    throw new Error(
      `${response.url()} → ${response.status()}: ${await response.text()}`
    );
  }
  return (await response.json()) as T;
}

/**
 * The few calls specs use to set up what they are not testing. Paths are
 * relative to /v1/.
 */
export class CoreApi {
  constructor(readonly request: APIRequestContext) {}

  async createUser(input: {
    email: string;
    name?: string;
    password?: string;
  }): Promise<CreatedUser> {
    const body = await json<{ user?: CreatedUser } & CreatedUser>(
      await this.request.post("admin/users", {
        data: { userType: "human", password: TEST_PASSWORD, ...input },
      })
    );
    return body.user ?? body;
  }

  async createRole(input: {
    name: string;
    displayName: string;
    description?: string;
    requires2fa?: boolean;
  }): Promise<CreatedRole> {
    const body = await json<{ role?: CreatedRole } & CreatedRole>(
      await this.request.post("admin/roles", { data: input })
    );
    return body.role ?? body;
  }

  async createBucket(name: string, description?: string): Promise<void> {
    await json(
      await this.request.post("files/buckets", {
        data: { name, description, policy: "private" },
      })
    );
  }

  async updateBucket(
    name: string,
    changes: { versioningEnabled?: boolean; description?: string }
  ): Promise<void> {
    await json(
      await this.request.put(`files/buckets/${name}`, { data: changes })
    );
  }

  async uploadObject(
    bucket: string,
    key: string,
    content: string,
    mimeType = "text/plain"
  ): Promise<CreatedObject> {
    const path = key.split("/").map(encodeURIComponent).join("/");
    const body = await json<{ object?: CreatedObject } & CreatedObject>(
      await this.request.put(`files/buckets/${bucket}/objects/${path}`, {
        headers: { "Idempotency-Key": randomUUID() },
        multipart: {
          file: {
            name: key.split("/").pop()!,
            mimeType,
            buffer: Buffer.from(content),
          },
        },
      })
    );
    return body.object ?? body;
  }

  async createWebhookEndpoint(input: {
    url: string;
    eventTypes: string[];
    description?: string;
  }): Promise<CreatedWebhookEndpoint> {
    const body = await json<
      { endpoint?: CreatedWebhookEndpoint } & CreatedWebhookEndpoint
    >(await this.request.post("webhooks/webhooks", { data: input }));
    return body.endpoint ?? body;
  }

  /** Permission ids by exact name (e.g. `webhooks.read`), in the order given. */
  async permissionIds(names: string[]): Promise<string[]> {
    return Promise.all(
      names.map(async (name) => {
        const body = await json<{ data: { id: string; name: string }[] }>(
          await this.request.get("admin/permissions", {
            params: { "filter[name]": name, "filter[name_op]": "equals" },
          })
        );
        const permission = body.data.find((p) => p.name === name);
        if (!permission) throw new Error(`No permission named ${name}`);
        return permission.id;
      })
    );
  }

  /** Replaces a role's permissions with the named ones. */
  async setRolePermissions(roleId: string, names: string[]): Promise<void> {
    await json(
      await this.request.put(`admin/roles/${roleId}/permissions`, {
        data: { permissionIds: await this.permissionIds(names) },
      })
    );
  }

  /** Replaces a user's global role assignments. */
  async setUserRoles(userId: string, roleIds: string[]): Promise<void> {
    await json(
      await this.request.put(`admin/users/${userId}/roles`, {
        data: { roleIds },
      })
    );
  }

  /**
   * The default organization, which first-run setup names. Found by its slug:
   * the list is ordered by id, so with other specs' organizations it may not
   * be on the first page.
   */
  async defaultOrganizationId(): Promise<string> {
    const body = await json<{ data: { id: string; isDefault: boolean }[] }>(
      await this.request.get("admin/organizations", {
        params: {
          "filter[slug]": e2e.organization.slug,
          "filter[slug_op]": "equals",
        },
      })
    );
    const org = body.data.find((o) => o.isDefault);
    if (!org) throw new Error("No default organization");
    return org.id;
  }

  /** An organization of the spec's own; a unique `name` gives a unique slug. */
  async createOrganization(name: string): Promise<CreatedOrganization> {
    return json<CreatedOrganization>(
      await this.request.post("admin/organizations", {
        data: { name, slug: name.toLowerCase(), code: orgCode() },
      })
    );
  }

  async deactivateOrganization(organizationId: string): Promise<void> {
    await json(
      await this.request.patch(`admin/organizations/${organizationId}`, {
        data: { isActive: false },
      })
    );
  }

  async addOrganizationMember(
    organizationId: string,
    userId: string,
    memberRole: MemberRole = "member"
  ): Promise<void> {
    await json(
      await this.request.post(`admin/organizations/${organizationId}/members`, {
        data: { userId, memberRole },
      })
    );
  }
}
