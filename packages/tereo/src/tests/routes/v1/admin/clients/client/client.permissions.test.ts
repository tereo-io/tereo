// @module-tag int
// @module-tag auth

import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { createTestClient } from "../../../../../support/auth/clients.js";
import { describe, it, expect, beforeAll } from "vitest";
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
