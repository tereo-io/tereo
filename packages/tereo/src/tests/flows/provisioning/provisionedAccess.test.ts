// @module-tag int
// @module-tag provisioning
import { getTestPrincipalToken } from "../../support/principals.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { CORE_URL } from "../../support/coreUrl.js";
import { fetchJson } from "../../support/http.js";
import { randomBytes } from "crypto";
import {
  provisionServices,
  newSlug,
  provisionDeclared,
} from "../../support/provisioning.js";
import {
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../../definitions/index.js";

const ROOT = CORE_URL;

let adminToken: string;

const rand = () => `x${randomBytes(5).toString("hex")}`;

const api = (
  method: string,
  path: string,
  token: string | null,
  body?: unknown
) => fetchJson(method, `${ROOT}${path}`, token, body);

interface Credentials {
  clientId: string;
  clientSecret: string;
}

const fetchToken = async ({ clientId, clientSecret }: Credentials) => {
  const response = await fetch(`${ROOT}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = (await response.json()) as { access_token?: string };
  return { status: response.status, token: body.access_token ?? null };
};

const tokenFor = async (service: { credentials: Credentials }) => {
  const { status, token } = await fetchToken(service.credentials);
  expect(status).toBe(200);
  return token!;
};

const accessOf = async (serviceId: string) =>
  prisma.serviceAccess.findMany({
    where: { serviceId },
    orderBy: [{ kind: "asc" }, { target: "asc" }],
  });

const decide = (
  serviceId: string,
  verb: "approve" | "revoke",
  ids: string[],
  token = adminToken
) =>
  api("POST", `/v1/admin/services/${serviceId}/access/${verb}`, token, {
    ids,
  });

const emit = (token: string, eventType: string) =>
  api("POST", "/v1/webhooks/events", token, {
    organizationId: DEFAULT_ORGANIZATION_ID,
    eventType,
    entityType: "Item",
    entityId: rand(),
    data: {},
  });

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({
    permissions: [
      "services.read",
      "services.write",
      "services.approve",
      "roles.read",
      "roles.write",
      // What the roles approved below grant: an approver grants only what
      // they hold.
      "webhooks.emit",
      "file-service.buckets.read",
      "file-service.objects.delete",
    ],
  });
});

describe("provisioned access", () => {
  it("works once applied; revoking takes it away, approving gives it back", async () => {
    const service = await provisionDeclared(
      {},
      { access: { roles: ["webhook_publisher"] } }
    );
    let token = await tokenFor(service);
    const eventType = `${service.namespace}.item.created`;

    const access = await accessOf(service.id);
    expect(access).toEqual([
      expect.objectContaining({
        kind: "role",
        target: "webhook_publisher",
        status: "approved",
        decidedBy: SYSTEM_USER_ID,
      }),
    ]);
    expect((await emit(token, eventType)).status).toBe(202);

    const revoked = await decide(service.id, "revoke", [access[0].id]);
    expect(revoked.status).toBe(200);
    expect((await emit(token, eventType)).status).toBe(401);
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        entityId: service.id,
        metadata: { path: ["action"], equals: "access_revoked" },
      },
    });
    expect(entry.metadata).toMatchObject({ accessTokensRevoked: 1 });
    token = await tokenFor(service);
    expect((await emit(token, eventType)).status).toBe(403);

    const approved = await decide(service.id, "approve", [access[0].id]);
    expect(approved.status).toBe(200);
    // Permissions resolve per request: the same token now succeeds.
    expect((await emit(token, eventType)).status).toBe(202);
  });

  it("only lets a service emit its own event types", async () => {
    const owner = await provisionDeclared();
    const other = await provisionDeclared(
      {},
      { access: { roles: ["webhook_publisher"] } }
    );
    const otherToken = await tokenFor(other);

    expect(
      (await emit(otherToken, `${other.namespace}.item.created`)).status
    ).toBe(202);
    expect(
      (await emit(otherToken, `${owner.namespace}.item.created`)).status
    ).toBe(403);
  });

  it("lets an approved audience introspect the service's tokens", async () => {
    const resourceSlug = newSlug();
    const [resource, issuer] = await provisionServices([
      { slug: resourceSlug },
      { access: { audiences: [resourceSlug] } },
    ]);

    const introspect = async (token: string) => {
      const { clientId, clientSecret } = resource.credentials;
      const response = await fetch(`${ROOT}/oauth/introspect`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `token=${encodeURIComponent(token)}`,
      });
      return ((await response.json()) as { active: boolean }).active;
    };

    expect(await introspect(await tokenFor(issuer))).toBe(true);
    const [row] = await accessOf(issuer.id);
    await decide(issuer.id, "revoke", [row.id]);
    // The audience is stamped when the token is issued.
    expect(await introspect(await tokenFor(issuer))).toBe(false);
  });
});

describe("file_user", () => {
  it("reads its own bucket's settings, not another service's", async () => {
    const bucketOwner = async () => {
      const slug = newSlug();
      const service = await provisionDeclared(
        { buckets: [{ bucketName: `${slug}-docs`, policy: "private" }] },
        { slug, access: { roles: ["file_user"] } }
      );
      return { token: await tokenFor(service), bucket: `${slug}-docs` };
    };
    const mine = await bucketOwner();
    const theirs = await bucketOwner();

    const own = await api(
      "GET",
      `/v1/files/buckets/${mine.bucket}`,
      mine.token
    );
    expect(own.status).toBe(200);
    expect(own.body.name).toBe(mine.bucket);

    expect(
      (await api("GET", `/v1/files/buckets/${theirs.bucket}`, mine.token))
        .status
    ).toBe(403);

    const listed = await api("GET", "/v1/files/buckets", mine.token);
    expect(listed.body.data.map((b: { name: string }) => b.name)).toEqual([
      mine.bucket,
    ]);
  });
});
