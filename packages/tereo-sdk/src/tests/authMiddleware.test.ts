import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthServiceClient } from "../clients/auth.js";
import { logger } from "../utils/logger.js";
import type { Request } from "express";

const { tryHandleRequest } = vi.hoisted(() => ({ tryHandleRequest: vi.fn() }));
vi.mock("../utils/tryHandleRequest.js", () => ({ tryHandleRequest }));

const active = {
  active: true,
  iss: "core",
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: 0,
  jti: "j",
  scope: "",
  client_id: "client-1",
};

const authenticate = async (
  token: string,
  client = new AuthServiceClient()
) => {
  const req = {
    headers: { authorization: `Bearer ${token}` },
    originalUrl: "/",
    method: "GET",
  } as Request;
  const next = vi.fn();
  await client.requireAuth(req, {} as never, next);
  return { req, error: next.mock.calls[0]?.[0] };
};

beforeEach(() => {
  tryHandleRequest.mockReset();
  vi.restoreAllMocks();
});

describe("requireAuth userType", () => {
  it("is human for a person's token without a session id", async () => {
    tryHandleRequest.mockResolvedValue({
      data: { ...active, sub: "user-1", user_id: "user-1" },
    });
    const { req } = await authenticate("person-no-refresh");
    expect(req.auth).toMatchObject({
      userId: "user-1",
      userType: "human",
      currentSessionId: null,
    });
  });

  it("is service_account for a client_credentials token, whose sub is its client", async () => {
    tryHandleRequest.mockResolvedValue({
      data: { ...active, sub: "client-1", user_id: "account-1" },
    });
    const { req } = await authenticate("service");
    expect(req.auth).toMatchObject({ userType: "service_account" });
  });
});

describe("requireAuth userId", () => {
  it("is the service-account user from user_id, not the token's sub", async () => {
    tryHandleRequest.mockResolvedValue({
      data: { ...active, sub: "client-1", user_id: "account-1" },
    });
    const { req } = await authenticate("service-user-id");
    expect(req.auth).toMatchObject({
      userId: "account-1",
      oauthClientId: "client-1",
    });
  });
});

describe("introspection failures", () => {
  it("answer 401 as before, and are logged at error with the cause", async () => {
    const failure = new Error("core unreachable");
    tryHandleRequest.mockRejectedValue(failure);
    const error = vi.spyOn(logger, "error");
    const { error: passed } = await authenticate("any");
    expect(passed).toMatchObject({ statusCode: 401 });
    expect(error).toHaveBeenCalledWith(
      { err: failure },
      expect.stringContaining("introspection failed")
    );
  });

  it("are not logged when core says the token is inactive", async () => {
    tryHandleRequest.mockResolvedValue({ data: { active: false } });
    const error = vi.spyOn(logger, "error");
    const { error: passed } = await authenticate("revoked");
    expect(passed).toMatchObject({ statusCode: 401 });
    expect(error).not.toHaveBeenCalled();
  });
});

describe("requireAuth client, scope and audience", () => {
  it("reads clientId, scope and audience from introspection", async () => {
    tryHandleRequest.mockResolvedValue({
      data: {
        ...active,
        sub: "user-1",
        user_id: "user-1",
        client_id: "login-client",
        scope: "openid  profile product:read",
        aud: "product-service",
      },
    });
    const { req } = await authenticate("third-party");
    expect(req.auth).toMatchObject({
      clientId: "login-client",
      oauthClientId: "login-client",
      scope: ["openid", "profile", "product:read"],
      audience: ["product-service"],
    });
  });

  it("gives an empty scope and audience when the token has none", async () => {
    tryHandleRequest.mockResolvedValue({
      data: { ...active, sub: "user-1", user_id: "user-1" },
    });
    const { req } = await authenticate("bare");
    expect(req.auth).toMatchObject({ scope: [], audience: [] });
  });

  it("keeps every audience of a list", async () => {
    tryHandleRequest.mockResolvedValue({
      data: { ...active, sub: "u", user_id: "u", aud: ["a", "b"] },
    });
    const { req } = await authenticate("multi-aud");
    expect(req.auth?.audience).toEqual(["a", "b"]);
  });
});

describe("requireAuth allowedClients", () => {
  const client = () =>
    new AuthServiceClient({ allowedClients: ["client-1", "product-ui"] });

  it("accepts a token issued to an allowed client", async () => {
    tryHandleRequest.mockResolvedValue({
      data: { ...active, sub: "u", user_id: "u" },
    });
    const { req, error } = await authenticate("allowed", client());
    expect(error).toBeUndefined();
    expect(req.auth?.clientId).toBe("client-1");
  });

  it("refuses with 401 a token issued to any other client", async () => {
    tryHandleRequest.mockResolvedValue({
      data: { ...active, sub: "u", user_id: "u", client_id: "third-party" },
    });
    const { req, error } = await authenticate("other", client());
    expect(error).toMatchObject({ statusCode: 401 });
    expect(req.auth).toBeUndefined();
  });
});

describe("requireScope", () => {
  const run = (scope: string[], ...required: string[]) => {
    const setHeader = vi.fn();
    const next = vi.fn();
    const req = { auth: { scope } } as unknown as Request;
    let thrown: unknown;
    try {
      new AuthServiceClient().requireScope(...required)(
        req,
        { setHeader } as never,
        next
      );
    } catch (err) {
      thrown = err;
    }
    return { thrown, next, setHeader };
  };

  it("passes when the token holds every required scope", () => {
    const { thrown, next } = run(["openid", "a", "b"], "a", "b");
    expect(thrown).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it("refuses with 403 and an insufficient_scope challenge otherwise", () => {
    const { thrown, next, setHeader } = run(["a"], "a", "b");
    expect(thrown).toMatchObject({ statusCode: 403 });
    expect((thrown as Error).message).toContain("b");
    expect(next).not.toHaveBeenCalled();
    expect(setHeader).toHaveBeenCalledWith(
      "WWW-Authenticate",
      'Bearer error="insufficient_scope", scope="a b"'
    );
  });

  it("refuses with 403 before requireAuth has run", () => {
    const next = vi.fn();
    expect(() =>
      new AuthServiceClient().requireScope("a")(
        {} as Request,
        { setHeader: vi.fn() } as never,
        next
      )
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });
});
