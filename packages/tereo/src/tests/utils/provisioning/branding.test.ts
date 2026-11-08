// @module-tag int
// @module-tag provisioning
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { loadProvisioningSet } from "../../../utils/provisioning/load.js";
import { applyProvisioning } from "../../../utils/provisioning/index.js";
import { DEFAULT_ORGANIZATION_ID } from "../../../definitions/index.js";
import { invalidateBranding } from "../../../utils/branding/resolve.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeLoginClients } from "../../support/provisioning.js";
import { LOGIN_CLIENT } from "../../../definitions/loginClient.js";
import { generateUniqueId } from "../../support/auth/crypto.js";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { prisma } from "../../../utils/db/prisma.js";
import { CORE_URL } from "../../support/coreUrl.js";
import { fetchJson } from "../../support/http.js";
import { randomBytes } from "node:crypto";
import { tmpdir } from "os";
import { join } from "path";
import axios from "axios";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../support/webhooks.js";
import {
  BRANDING_URL,
  brandingPrincipal,
  deleteDefaultProfile,
  clearDefaultProfile,
} from "../../support/branding.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
// Unique content, so no other test's object is reused.
const uniquePng = () => Buffer.concat([PNG, randomBytes(16)]);

const loginClient = (clientId: string) => ({
  clientId,
  name: `Branded ${clientId}`,
  redirectUris: ["https://app.example.com/callback"],
});

describe("provisioned branding", () => {
  let dir: string;
  let admin: Awaited<ReturnType<typeof brandingPrincipal>>;
  let endpointId: string;
  const clientIds: string[] = [];

  const newClientId = () => {
    const id = `prov-brand-${generateUniqueId()}`;
    clientIds.push(id);
    return id;
  };

  const writeDocument = (body: Record<string, unknown>) =>
    writeFile(
      join(dir, "app.json"),
      JSON.stringify({ version: "1.0.0", ...body })
    );

  const apply = async () =>
    applyProvisioning((await loadProvisioningSet(dir, {}))!);

  const profileOf = (clientId: string) =>
    prisma.brandingProfile.findFirstOrThrow({
      where: { client: { clientId } },
    });

  const auditCount = (entityId: string) =>
    prisma.auditLogEntry.count({
      where: { entityType: "BrandingProfile", entityId },
    });

  const adminPut = async (clientId: string) => {
    const client = await prisma.oAuthClient.findUniqueOrThrow({
      where: { clientId },
    });
    return await fetchJson(
      "PUT",
      `${BRANDING_URL}/clients/${client.id}`,
      admin.token,
      { appName: "From the admin UI" }
    );
  };

  beforeAll(async () => {
    await ensureDefaultOrganization();
    dir = await mkdtemp(join(tmpdir(), "provisioning-branding-"));
    await mkdir(join(dir, "branding"));
    admin = await brandingPrincipal(["branding.admin"]);
    endpointId = (
      await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
        { eventTypes: ["auth.branding.updated"] }
      )
    ).id;
  });

  afterAll(async () => {
    // An empty set would refuse; a document with only a client hands every
    // provisioned profile back, then the client goes.
    const last = newClientId();
    await writeDocument({ clients: [loginClient(last)] });
    await apply();
    await removeLoginClients(clientIds);
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a declared profile as provisioned, read-only to the admin API", async () => {
    const clientId = newClientId();
    await writeDocument({
      clients: [loginClient(clientId)],
      branding: {
        clients: {
          [clientId]: {
            headline: "Welcome back",
            colorsLight: { "--k-primary-color": "#0b5" },
          },
        },
      },
    });
    const result = await apply();
    expect(result.branding).toEqual([clientId]);

    const row = await profileOf(clientId);
    expect(row).toMatchObject({
      headline: "Welcome back",
      appName: null,
      colorsLight: { "--k-primary-color": "#0b5" },
      provisioned: true,
      provisionedFrom: "app.json",
    });
    expect((await adminPut(clientId)).status).toBe(409);

    const audits = await auditCount(row.id);
    const again = await apply();
    expect(again.branding).toEqual([]);
    expect(await auditCount(row.id)).toBe(audits);
  });

  it("stores a declared image once and replaces it when the file changes", async () => {
    const clientId = newClientId();
    const logo = join(dir, "branding", "logo.png");
    const first = uniquePng();
    await writeFile(logo, first);
    await writeDocument({
      clients: [loginClient(clientId)],
      branding: { clients: { [clientId]: { logo: "./branding/logo.png" } } },
    });
    await apply();

    const row = await profileOf(clientId);
    const object = await prisma.object.findUniqueOrThrow({
      where: { id: row.logoObjectId! },
    });
    expect(object.deleteAfter).toBeNull();
    const asset = await axios.get(
      `${CORE_URL}/oauth/branding/assets/${object.objectKey}`,
      { responseType: "arraybuffer", validateStatus: () => true }
    );
    expect(asset.status).toBe(200);
    expect(Buffer.from(asset.data).equals(first)).toBe(true);

    const result = await apply();
    expect(result.branding).toEqual([]);
    expect(
      await prisma.object.count({
        where: {
          objectKey: object.objectKey,
          deletedAt: null,
          thumbnailFor: null,
        },
      })
    ).toBe(1);

    await writeFile(logo, uniquePng());
    expect((await apply()).branding).toEqual([clientId]);
    const replaced = await profileOf(clientId);
    expect(replaced.logoObjectId).not.toBeNull();
    expect(replaced.logoObjectId).not.toBe(object.id);
    const old = await prisma.object.findUniqueOrThrow({
      where: { id: object.id },
    });
    expect(old.deleteAfter).not.toBeNull();
  });

  it("hands a profile back to the admin API when the block goes, keeping its values", async () => {
    const clientId = newClientId();
    await writeDocument({
      clients: [loginClient(clientId)],
      branding: { clients: { [clientId]: { appName: "Kept" } } },
    });
    await apply();

    await writeDocument({ clients: [loginClient(clientId)] });
    const result = await apply();
    expect(result.branding).toContain(clientId);
    const row = await profileOf(clientId);
    expect(row).toMatchObject({
      appName: "Kept",
      provisioned: false,
      provisionedFrom: null,
    });
    const released = await prisma.auditLogEntry.findFirstOrThrow({
      where: { entityType: "BrandingProfile", entityId: row.id },
      orderBy: { createdAt: "desc" },
    });
    expect(released.metadata).toMatchObject({
      before: { provisioned: true, provisionedFrom: "app.json" },
      after: { provisioned: false, provisionedFrom: null },
    });
    const where = {
      webhookEndpointId: endpointId,
      eventType: "auth.branding.updated",
      payload: { path: ["entityId"], equals: row.id },
    };
    await waitFor(
      async () => (await prisma.webhookDelivery.count({ where })) >= 2,
      10_000
    );
    const events = await prisma.webhookDelivery.findMany({ where });
    expect(events.map((e) => (e.payload as { data: unknown }).data)).toEqual(
      expect.arrayContaining([{ clientId, changedSlots: [], released: true }])
    );
    expect((await adminPut(clientId)).status).toBe(200);
  });

  it("refuses a client that is in neither the set nor the database, writing nothing", async () => {
    const declared = newClientId();
    const missing = `prov-brand-missing-${generateUniqueId()}`;
    await writeDocument({
      clients: [loginClient(declared)],
      branding: { clients: { [missing]: { appName: "Nobody" } } },
    });
    await expect(apply()).rejects.toMatchObject({
      name: "ProvisioningError",
      problems: [expect.stringContaining(`branding.clients[${missing}]`)],
    });
    expect(
      await prisma.oAuthClient.findUnique({ where: { clientId: declared } })
    ).toBeNull();
  });

  it("brands the console when tereo-ui declares applyToConsole", async (ctx) => {
    const consoleClient = await prisma.oAuthClient.findUnique({
      where: { clientId: LOGIN_CLIENT.clientId },
      select: { id: true },
    });
    const existing =
      consoleClient &&
      (await prisma.brandingProfile.findFirst({
        where: { clientId: consoleClient.id },
      }));
    if (!consoleClient || existing) ctx.skip();
    await clearDefaultProfile();

    const getConsole = async (done: (html: string) => boolean) => {
      const get = () =>
        axios.get<string>(`${CORE_URL}/auth-admin/users`, {
          headers: { Accept: "text/html" },
          responseType: "text",
          validateStatus: () => true,
        });
      let response = await get();
      for (let i = 0; i < 40 && !done(response.data); i++) {
        await new Promise((r) => setTimeout(r, 50));
        response = await get();
      }
      return response.data;
    };

    try {
      await writeDocument({
        branding: {
          default: { appName: "Provisioned Co" },
          clients: { [LOGIN_CLIENT.clientId]: { applyToConsole: true } },
        },
      });
      const result = await apply();
      expect(result.branding.sort()).toEqual(
        ["default", LOGIN_CLIENT.clientId].sort()
      );
      const html = await getConsole((h) => h.includes('id="tereo-branding"'));
      expect(html).toContain('id="tereo-branding"');
      expect(html).toContain("<title>Provisioned Co</title>");
    } finally {
      await prisma.brandingProfile.deleteMany({
        where: { clientId: consoleClient!.id },
      });
      await deleteDefaultProfile();
      await invalidateBranding();
    }
  });
});
