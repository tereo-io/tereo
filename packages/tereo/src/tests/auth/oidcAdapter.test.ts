import { openProviderSecret } from "../../utils/identityProviders/clientSecret.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { UpstreamAuthError } from "../../utils/identityProviders/errors.js";
import { guardedFetch } from "../../utils/identityProviders/fetch.js";
import { SYSTEM_USER_ID } from "../../definitions/systemUser.js";
import { sealRowSecret } from "../../utils/sealedSecrets.js";
import { prisma } from "../../utils/db/prisma.js";
import { currentKek } from "../../utils/keys.js";
import { randomBytes, randomUUID } from "crypto";
import env from "../../env.js";
import type {
  IdentityProvider,
  UpstreamAuthCheck,
} from "../../utils/identityProviders/types.js";
import {
  adapterFor,
  upstreamCallbackUrl,
} from "../../utils/identityProviders/index.js";
import {
  broadcastIdentityProviderInvalidate,
  closeCacheBroadcast,
  onIdentityProviderInvalidate,
  startCacheSubscriber,
} from "../../utils/cacheBroadcast.js";
import {
  type FakeOidcProvider,
  startFakeOidcProvider,
} from "../utils/fakeOidcProvider.js";

const adapter = adapterFor("oidc");

let fake: FakeOidcProvider;

beforeAll(async () => {
  fake = await startFakeOidcProvider();
});

afterAll(async () => {
  await fake.close();
});

const providerFor = async (
  p: FakeOidcProvider,
  overrides: Partial<IdentityProvider> = {}
): Promise<IdentityProvider> => {
  const id = randomUUID();
  return {
    id,
    slug: `fake-${randomBytes(3).toString("hex")}`,
    displayName: "Fake",
    kind: "oidc",
    issuer: p.issuer,
    clientId: p.clientId,
    clientSecret: await sealRowSecret(
      `identity-provider:${id}`,
      p.clientSecret
    ),
    scopes: ["openid", "email", "profile"],
    countsAsMfa: false,
    isActive: true,
    createdBy: SYSTEM_USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
};

const inputFor = (p: FakeOidcProvider) => ({
  kind: "oidc" as const,
  issuer: p.issuer,
  clientId: p.clientId,
  clientSecret: p.clientSecret,
  scopes: ["openid", "email", "profile"],
});

const newCheck = (provider: IdentityProvider): UpstreamAuthCheck => ({
  state: randomBytes(16).toString("base64url"),
  nonce: randomBytes(16).toString("base64url"),
  codeVerifier: randomBytes(32).toString("base64url"),
  redirectUri: upstreamCallbackUrl(provider.slug),
});

/** Sends the browser's leg: the provider redirects straight back. */
const callbackFor = async (authorizationUrl: URL): Promise<URL> => {
  const res = await fetch(authorizationUrl, { redirect: "manual" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
};

const signIn = async (
  provider: IdentityProvider,
  check = newCheck(provider)
) => {
  const callback = await callbackFor(
    await adapter.authorizationUrl(provider, check)
  );
  return adapter.complete(provider, callback, check);
};

const rejectsWith = async (promise: Promise<unknown>, code: string) => {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(UpstreamAuthError);
  expect((err as UpstreamAuthError).code).toBe(code);
};

const rejectsWithBadRequest = async (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ statusCode: 400, code });

describe("oidc adapter: validateConfig", () => {
  let allowPrivate: boolean;
  beforeAll(() => {
    allowPrivate = env.OIDC_ALLOW_PRIVATE_ISSUERS;
  });
  afterEach(() => {
    env.OIDC_ALLOW_PRIVATE_ISSUERS = allowPrivate;
  });

  it("accepts the fake provider", async () => {
    await expect(adapter.validateConfig(inputFor(fake))).resolves.toBe(
      undefined
    );
  });

  it("refuses a discovery document naming another issuer", async () => {
    const other = await startFakeOidcProvider({
      issuerOverride: "https://elsewhere.example.com",
    });
    try {
      await rejectsWithBadRequest(
        adapter.validateConfig(inputFor(other)),
        "invalid_provider_config"
      );
    } finally {
      await other.close();
    }
  });

  it("refuses a provider without S256 PKCE", async () => {
    const other = await startFakeOidcProvider({ noS256: true });
    try {
      await rejectsWithBadRequest(
        adapter.validateConfig(inputFor(other)),
        "invalid_provider_config"
      );
    } finally {
      await other.close();
    }
  });

  it("refuses a private issuer without OIDC_ALLOW_PRIVATE_ISSUERS", async () => {
    env.OIDC_ALLOW_PRIVATE_ISSUERS = false;

    await rejectsWithBadRequest(
      adapter.validateConfig(inputFor(fake)),
      "provider_unreachable"
    );
    await rejectsWithBadRequest(
      adapter.validateConfig({
        ...inputFor(fake),
        issuer: "https://127.0.0.1:1",
      }),
      "provider_unreachable"
    );
  });

  it("guardedFetch refuses a private address without the flag", async () => {
    env.OIDC_ALLOW_PRIVATE_ISSUERS = false;

    await expect(
      guardedFetch(`${fake.issuer.replace("localhost", "127.0.0.1")}/jwks`)
    ).rejects.toThrow(/private/);
  });
});

describe("oidc adapter: sign-in", () => {
  it("builds an authorization URL carrying state, nonce and S256", async () => {
    const provider = await providerFor(fake);
    const check = newCheck(provider);

    const url = await adapter.authorizationUrl(provider, check);

    expect(url.origin).toBe(fake.issuer);
    expect(url.searchParams.get("state")).toBe(check.state);
    expect(url.searchParams.get("nonce")).toBe(check.nonce);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBe(check.redirectUri);
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });

  it("returns the bound identity, with the email lower-cased", async () => {
    const provider = await providerFor(fake);
    fake.nextIdentity({
      sub: "user-123",
      email: "Ada.Lovelace@Example.COM",
      email_verified: true,
      name: "Ada Lovelace",
      given_name: "Ada",
      family_name: "Lovelace",
      hd: "example.com",
    });

    await expect(signIn(provider)).resolves.toEqual({
      subject: "user-123",
      email: "ada.lovelace@example.com",
      emailVerified: true,
      name: "Ada Lovelace",
      firstName: "Ada",
      lastName: "Lovelace",
      hostedDomain: "example.com",
    });
  });

  it("drops an email claim that is not one address", async () => {
    const provider = await providerFor(fake);
    fake.nextIdentity({
      sub: "user-321",
      email: "attacker@evil.com, ada@example.com",
      email_verified: true,
    });

    await expect(signIn(provider)).resolves.toMatchObject({
      subject: "user-321",
      email: null,
    });
  });

  it("treats a missing or non-true email_verified as unverified", async () => {
    const provider = await providerFor(fake);
    fake.nextIdentity({ sub: "user-456" });

    await expect(signIn(provider)).resolves.toEqual({
      subject: "user-456",
      email: null,
      emailVerified: false,
      name: null,
      firstName: null,
      lastName: null,
      hostedDomain: null,
    });
  });

  it.each([
    ["nonce", { nonce: "not-the-nonce" }],
    ["aud", { aud: "another-client" }],
    ["iss", { iss: "https://impostor.example.com" }],
  ])("rejects an id_token with the wrong %s", async (_, tamper) => {
    const provider = await providerFor(fake);
    fake.nextIdentity({ sub: "user-789" });
    fake.tamper(tamper);

    await rejectsWith(signIn(provider), "upstream_failed");
  });

  it("rejects an id_token not signed by a key in the provider's JWKS", async () => {
    const provider = await providerFor(fake);
    fake.nextIdentity({ sub: "user-789" });
    fake.tamper({ signWithOtherKey: true });

    await rejectsWith(signIn(provider), "upstream_failed");
  });

  it("verifies the id_token against the provider's JWKS", async () => {
    const other = await startFakeOidcProvider();
    try {
      const provider = await providerFor(other);
      other.nextIdentity({ sub: "user-789" });

      await signIn(provider);

      expect(other.jwksRequests()).toBeGreaterThan(0);
    } finally {
      await other.close();
    }
  });

  it("rejects a callback whose iss names another issuer", async () => {
    const provider = await providerFor(fake);
    const check = newCheck(provider);
    fake.nextIdentity({ sub: "user-789" });
    const callback = await callbackFor(
      await adapter.authorizationUrl(provider, check)
    );
    callback.searchParams.set("iss", "https://impostor.example.com");

    await rejectsWith(
      adapter.complete(provider, callback, check),
      "upstream_failed"
    );
  });

  it("rejects a callback with another session's state", async () => {
    const provider = await providerFor(fake);
    fake.nextIdentity({ sub: "user-789" });
    const callback = await callbackFor(
      await adapter.authorizationUrl(provider, newCheck(provider))
    );

    await rejectsWith(
      adapter.complete(provider, callback, newCheck(provider)),
      "upstream_failed"
    );
  });

  it("maps access_denied to upstream_cancelled", async () => {
    const provider = await providerFor(fake);
    fake.tamper({ error: "access_denied" });

    await rejectsWith(signIn(provider), "upstream_cancelled");
  });

  it("maps other provider errors to upstream_failed", async () => {
    const provider = await providerFor(fake);
    fake.tamper({ error: "server_error" });

    await rejectsWith(signIn(provider), "upstream_failed");
  });

  it("opens the client secret sealed under the provider's own name", async () => {
    const provider = await providerFor(fake);
    const moved = {
      ...provider,
      clientSecret: await sealRowSecret(
        "identity-provider:someone-else",
        fake.clientSecret
      ),
    };

    await expect(
      adapter.authorizationUrl(moved, newCheck(moved))
    ).rejects.toThrow();
  });
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

describe("identity provider invalidation", () => {
  afterAll(async () => {
    await closeCacheBroadcast();
  });

  it("reaches onIdentityProviderInvalidate listeners", async () => {
    await startCacheSubscriber();
    const id = randomUUID();
    const received = new Promise<string>((resolve) => {
      onIdentityProviderInvalidate((got) => {
        if (got === id) resolve(got);
      });
    });

    await broadcastIdentityProviderInvalidate(id);

    await expect(received).resolves.toBe(id);
  });
});
