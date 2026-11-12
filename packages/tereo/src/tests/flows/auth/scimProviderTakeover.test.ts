// @module-tag int
// @module-tag auth
// @module-tag security
import { clientSecretName } from "../../../utils/identityProviders/clientSecret.js";
import { createScimConnection, scimFetch } from "../../support/scim.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealRowSecret } from "../../../utils/sealedSecrets.js";
import { oktaCreateUser } from "../../fixtures/scim/okta.js";
import { BASE_URL } from "../../support/auth/constants.js";
import { prisma } from "../../../utils/db/prisma.js";
import { fetchJson } from "../../support/http.js";
import { tag } from "../../support/scimUsers.js";
import {
  startFakeOidcProvider,
  type FakeOidcProvider,
} from "../../support/fakeOidcProvider.js";

let legit: FakeOidcProvider;
let attacker: FakeOidcProvider;
let delegated: string;

beforeAll(async () => {
  legit = await startFakeOidcProvider();
  attacker = await startFakeOidcProvider();
  delegated = await getTestPrincipalToken({
    permissions: ["identity-providers.write"],
  });
});

afterAll(async () => {
  await legit.close();
  await attacker.close();
});

/**
 * A provider pointing at `legit` with a SCIM connection, and a user the IdP
 * provisioned who has never signed in through it.
 */
const provisionedVictim = async () => {
  const c = await createScimConnection();
  await prisma.identityProvider.update({
    where: { id: c.providerId },
    data: {
      issuer: legit.issuer,
      clientId: legit.clientId,
      clientSecret: await sealRowSecret(
        clientSecretName(c.providerId),
        legit.clientSecret
      ),
    },
  });
  const email = `admin-${tag()}@${c.domain}`;
  const provisioned = await scimFetch(c.token, "POST", "/scim/v2/Users", {
    ...oktaCreateUser,
    userName: email,
    emails: [{ primary: true, type: "work", value: email }],
  });
  expect(provisioned.status).toBe(201);
  return { c, email, victimId: provisioned.body.id as string };
};

const repoint = (providerId: string) =>
  fetchJson(
    "PATCH",
    `${BASE_URL}/v1/admin/identity-providers/${providerId}`,
    delegated,
    {
      issuer: attacker.issuer,
      clientId: attacker.clientId,
      clientSecret: attacker.clientSecret,
    }
  );

describe("SCIM provider takeover (Scenario A)", () => {
  it("refuses a delegated admin repointing a SCIM provider nobody has signed in through", async () => {
    const { c, victimId } = await provisionedVictim();
    expect((await repoint(c.providerId)).status).toBe(403);
    expect(
      await prisma.identityProvider.findUniqueOrThrow({
        where: { id: c.providerId },
      })
    ).toMatchObject({ issuer: legit.issuer, clientId: legit.clientId });
    expect(
      await prisma.userIdentity.count({ where: { userId: victimId } })
    ).toBe(0);
  });
});
