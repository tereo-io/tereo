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

const authenticate = async (token: string) => {
  const req = {
    headers: { authorization: `Bearer ${token}` },
    originalUrl: "/",
    method: "GET",
  } as Request;
  const next = vi.fn();
  await new AuthServiceClient().requireAuth(req, {} as never, next);
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
