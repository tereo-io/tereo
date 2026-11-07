// @module-tag int
// @module-tag auth
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchJson } from "../../../../../../../support/http.js";
import { randomUUID } from "node:crypto";
import {
  BRANDING_URL,
  brandingPrincipal,
  createBrandingClient,
  deleteBrandingClients,
} from "../../../../../../../support/branding.js";

type Principal = Awaited<ReturnType<typeof brandingPrincipal>>;

describe("/v1/admin/branding/clients/:id/grants", () => {
  let owner: Principal;
  let grantee: Principal;
  const clientIds: string[] = [];

  const grantsUrl = (id: string) => `${BRANDING_URL}/clients/${id}/grants`;
  const put = (id: string, token: string) =>
    fetchJson("PUT", `${BRANDING_URL}/clients/${id}`, token, {
      headline: "Hello",
    });

  beforeAll(async () => {
    [owner, grantee] = await Promise.all([
      brandingPrincipal(["branding.write"]),
      brandingPrincipal(["branding.write"]),
    ]);
  });

  afterAll(async () => {
    await deleteBrandingClients(clientIds);
  });

  const newClient = async () => {
    const client = await createBrandingClient(owner.userId);
    clientIds.push(client.id);
    return client;
  };

  it("grants, lists, lets the grantee edit, and revokes", async () => {
    const client = await newClient();
    expect((await put(client.id, grantee.token)).status).toBe(403);

    const added = await fetchJson("POST", grantsUrl(client.id), owner.token, {
      userId: grantee.userId,
    });
    expect(added.status).toBe(201);
    expect((await put(client.id, grantee.token)).status).toBe(200);

    const list = await fetchJson("GET", grantsUrl(client.id), owner.token);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      userId: grantee.userId,
      grantedBy: owner.userId,
    });
    expect(list.body.data[0]).toHaveProperty("email");
    expect(list.body.data[0]).toHaveProperty("name");
    expect(typeof list.body.data[0].grantedAt).toBe("string");

    const revoked = await fetchJson(
      "DELETE",
      `${grantsUrl(client.id)}/${grantee.userId}`,
      owner.token
    );
    expect(revoked.status).toBe(204);
    expect((await put(client.id, grantee.token)).status).toBe(403);
    expect(
      (await fetchJson("GET", grantsUrl(client.id), owner.token)).body.data
    ).toEqual([]);
  });

  it("can grant again after a revoke", async () => {
    const client = await newClient();
    const body = { userId: grantee.userId };
    const url = grantsUrl(client.id);
    expect((await fetchJson("POST", url, owner.token, body)).status).toBe(201);
    await fetchJson("DELETE", `${url}/${grantee.userId}`, owner.token);
    expect((await fetchJson("POST", url, owner.token, body)).status).toBe(201);
  });

  it("answers 409 for a duplicate active grant", async () => {
    const client = await newClient();
    const body = { userId: grantee.userId };
    const url = grantsUrl(client.id);
    await fetchJson("POST", url, owner.token, body);
    const res = await fetchJson("POST", url, owner.token, body);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conflict");
  });

  it("answers 404 for an unknown user", async () => {
    const client = await newClient();
    const res = await fetchJson("POST", grantsUrl(client.id), owner.token, {
      userId: randomUUID(),
    });
    expect(res.status).toBe(404);
  });

  it("answers 404 for an unknown client", async () => {
    const res = await fetchJson("GET", grantsUrl(randomUUID()), owner.token);
    expect(res.status).toBe(404);
  });

  it("answers 400 for a malformed body", async () => {
    const client = await newClient();
    const res = await fetchJson("POST", grantsUrl(client.id), owner.token, {
      userId: "nope",
    });
    expect(res.status).toBe(400);
  });

  it("answers 400 user_inactive for a deactivated user", async () => {
    const client = await newClient();
    const inactive = await brandingPrincipal(["branding.write"]);
    await prisma.user.update({
      where: { id: inactive.userId },
      data: { isActive: false },
    });
    const res = await fetchJson("POST", grantsUrl(client.id), owner.token, {
      userId: inactive.userId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("user_inactive");
  });
});
