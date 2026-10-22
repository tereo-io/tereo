// @module-tag int
// @module-tag auth

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mapUniqueViolation } from "../../utils/prismaErrors.js";
import { getTestPrincipalToken } from "../support/principals.js";
import { generateUniqueId } from "../support/auth.js";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "../support/coreUrl.js";
import { randomUUID } from "node:crypto";
import {
  startFakeOidcProvider,
  FakeOidcProvider,
} from "../support/fakeOidcProvider.js";

const BASE = `${CORE_URL}/v1/admin/identity-providers`;

let fake: FakeOidcProvider;
let writeToken: string;

beforeAll(async () => {
  fake = await startFakeOidcProvider();
  writeToken = await getTestPrincipalToken({
    permissions: ["identity-providers.write"],
  });
});

afterAll(async () => {
  await fake.close();
});

const call = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const createProvider = async (overrides: Record<string, unknown> = {}) => {
  const response = await call(writeToken, "POST", "", {
    slug: `p-${generateUniqueId().toLowerCase()}`.slice(0, 40),
    displayName: "Fake IdP",
    kind: "oidc",
    issuer: fake.issuer,
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    ...overrides,
  });
  return response;
};

const newProvider = async () => {
  const response = await createProvider();
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; slug: string };
};

describe("mapUniqueViolation", () => {
  it("maps a unique-index violation to the given code", async () => {
    const provider = await newProvider();
    const dup = await prisma.identityProvider.findUniqueOrThrow({
      where: { id: provider.id },
    });
    // The pre-check cannot be interleaved from a test, so provoke the
    // real database error the race would produce.
    const err = await mapUniqueViolation(
      () =>
        prisma.identityProvider.create({
          data: { ...dup, id: randomUUID() },
        }),
      "taken",
      "slug_taken"
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 409, code: "slug_taken" });
  });
});
