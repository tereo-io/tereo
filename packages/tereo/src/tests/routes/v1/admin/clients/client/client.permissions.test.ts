// @module-tag int
// @module-tag auth

import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { createTestClient } from "../../../../../support/auth/clients.js";
import { LOGIN_CLIENT } from "../../../../../../definitions/index.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import env from "../../../../../../env.js";
import {
  BASE_URL,
  HTTP_STATUS,
} from "../../../../../support/auth/constants.js";

interface ErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
  [key: string]: unknown;
}

let managedClient: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  managedClient = await createTestClient({ clientType: "confidential" });
});

describe("GET, PATCH and DELETE /v1/admin/clients/:id and POST /v1/admin/clients/:id/regenerate-secret for a caller who neither owns the client nor holds clients.admin", () => {
  let token: string;

  beforeAll(async () => {
    token = await getTestPrincipalToken({
      permissions: ["clients.read", "clients.write", "clients.delete"],
    });
  });

  it.each([
    ["GET", ""],
    ["PATCH", ""],
    ["DELETE", ""],
    ["POST", "/regenerate-secret"],
  ])("gets 403 forbidden from %s %s", async (method, suffix) => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/clients/${managedClient.id}${suffix}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(method === "PATCH" && {
          body: JSON.stringify({ name: "Not Mine" }),
        }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBe("forbidden");
  });
});

describe("PATCH /v1/admin/clients/:id on the admin UI's login client", () => {
  it("refuses a post-logout URI off the UI's origin", async () => {
    const clientsAdmin = await getTestPrincipalToken({
      permissions: ["clients.admin"],
    });
    const loginClient = await prisma.oAuthClient.findUniqueOrThrow({
      where: { clientId: LOGIN_CLIENT.clientId },
    });
    const patch = (postLogoutRedirectUris: string[]) =>
      fetch(`${BASE_URL}/v1/admin/clients/${loginClient.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${clientsAdmin}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ postLogoutRedirectUris }),
      });
    const origin = new URL(env.UI_BASE_URL).origin;

    // Another site, and the UI's host on another port.
    for (const uri of [
      "https://elsewhere.example/signed-out",
      "http://localhost:4999/signed-out",
    ]) {
      const refused = await patch([`${origin}/signed-out`, uri]);
      expect(refused.status).toBe(HTTP_STATUS.CONFLICT);
    }
    expect(
      (
        await prisma.oAuthClient.findUniqueOrThrow({
          where: { id: loginClient.id },
        })
      ).postLogoutRedirectUris
    ).toEqual(loginClient.postLogoutRedirectUris);

    try {
      const kept = await patch([`${origin}/signed-out`]);
      expect(kept.status).toBe(HTTP_STATUS.OK);
      expect(
        ((await kept.json()) as { postLogoutRedirectUris: string[] })
          .postLogoutRedirectUris
      ).toEqual([`${origin}/signed-out`]);
    } finally {
      await prisma.oAuthClient.update({
        where: { id: loginClient.id },
        data: { postLogoutRedirectUris: loginClient.postLogoutRedirectUris },
      });
    }
  });
});
