// @module-tag int
// @module-tag auth
import { openProviderSecret } from "../../../utils/identityProviders/clientSecret.js";
import { SYSTEM_USER_ID } from "../../../definitions/systemUser.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealRowSecret } from "../../../utils/sealedSecrets.js";
import { prisma } from "../../../utils/db/prisma.js";
import { currentKek } from "../../../utils/keys.js";
import { randomBytes } from "node:crypto";
import {
  type FakeOidcProvider,
  startFakeOidcProvider,
} from "../../support/fakeOidcProvider.js";

let fake: FakeOidcProvider;

beforeAll(async () => {
  fake = await startFakeOidcProvider();
});

afterAll(async () => {
  await fake.close();
});

describe("openProviderSecret", () => {
  const ids: string[] = [];
  afterAll(async () => {
    await prisma.identityProvider.deleteMany({ where: { id: { in: ids } } });
  });

  const insertRow = async (clientSecret: string) => {
    const row = await prisma.identityProvider.create({
      data: {
        slug: `fake-${randomBytes(3).toString("hex")}`,
        displayName: "Fake",
        kind: "oidc",
        issuer: fake.issuer,
        clientId: fake.clientId,
        clientSecret,
        createdBy: SYSTEM_USER_ID,
      },
    });
    ids.push(row.id);
    return row;
  };

  it("opens through openRowSecret and leaves a current seal alone", async () => {
    const row = await insertRow("placeholder");
    const sealed = await sealRowSecret(`identity-provider:${row.id}`, "s3cret");
    const current = await prisma.identityProvider.update({
      where: { id: row.id },
      data: { clientSecret: sealed },
    });

    await expect(openProviderSecret(current)).resolves.toBe("s3cret");
    const after = await prisma.identityProvider.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.clientSecret).toBe(sealed);
  });

  it("writes a resealed value back while the row is unchanged", async () => {
    const row = await insertRow("s3cret");

    await expect(openProviderSecret(row)).resolves.toBe("s3cret");
    const after = await prisma.identityProvider.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.clientSecret).toMatch(new RegExp(`^kek1:${currentKek().id}:`));
  });

  it("does not overwrite a secret changed since it was read", async () => {
    const row = await insertRow("s3cret");
    const replaced = await sealRowSecret(`identity-provider:${row.id}`, "new");
    await prisma.identityProvider.update({
      where: { id: row.id },
      data: { clientSecret: replaced },
    });

    await expect(openProviderSecret(row)).resolves.toBe("s3cret");
    const after = await prisma.identityProvider.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.clientSecret).toBe(replaced);
  });
});
