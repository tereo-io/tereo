import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { authFromInfo, createVerifier } from "../verifier.js";
import { describe, expect, it, vi } from "vitest";
import { fakeCore } from "./support/fakeCore.js";

const resourceUrl = "https://app.example.com/mcp";
const token = (rest = "client=claude|perms=q.read") =>
  `test-token-user-1|${rest}`;

const make = (
  core = fakeCore(),
  extra: Partial<Parameters<typeof createVerifier>[0]> = {}
) =>
  createVerifier({
    core,
    allowedClients: ["claude"],
    allowServiceAccounts: false,
    resourceUrl,
    ...extra,
  });

const refusal = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(OAuthError);
  expect((err as OAuthError).code).toBe(OAuthErrorCode.InvalidToken);
  return err as OAuthError;
};

describe("createVerifier", () => {
  it("accepts an active token from an allowed client", async () => {
    const result = await make().verifyAccessToken(token());
    expect(result).toMatchObject({
      token: token(),
      clientId: "claude",
      scopes: ["openid", "profile", "email"],
    });
    expect(result.resource).toEqual(new URL(resourceUrl));
    expect(result.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(authFromInfo(result)).toMatchObject({
      userId: "user-1",
      userType: "human",
      permissions: ["q.read"],
      clientId: "claude",
    });
  });

  it("refuses an inactive token", async () => {
    await refusal(make().verifyAccessToken("garbage"));
  });

  it("refuses a client that is not allowed", async () => {
    await refusal(make().verifyAccessToken(token("client=other")));
  });

  it("refuses a service account unless allowed", async () => {
    const t = "test-token-claude|client=claude";
    await refusal(make().verifyAccessToken(t));
    const result = await make(fakeCore(), {
      allowServiceAccounts: true,
    }).verifyAccessToken(t);
    expect(authFromInfo(result)?.userType).toBe("service_account");
  });

  it("refuses a token that expires at or before now", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const core = fakeCore({ exp });
    await refusal(
      make(core, { now: () => exp * 1000 }).verifyAccessToken(token())
    );
    await refusal(
      make(core, { now: () => exp * 1000 + 1 }).verifyAccessToken(token())
    );
    const ok = await make(core, {
      now: () => exp * 1000 - 1,
    }).verifyAccessToken(token());
    expect(ok.expiresAt).toBe(exp);
  });

  it("sends the same message for every reason and logs the real one", async () => {
    const info = vi.fn();
    const logger = { info } as never;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const errors = await Promise.all([
      refusal(make(fakeCore(), { logger }).verifyAccessToken("garbage")),
      refusal(
        make(fakeCore(), { logger }).verifyAccessToken(token("client=other"))
      ),
      refusal(
        make(fakeCore(), { logger }).verifyAccessToken(
          "test-token-claude|client=claude"
        )
      ),
      refusal(
        make(fakeCore({ exp }), {
          logger,
          now: () => exp * 1000,
        }).verifyAccessToken(token())
      ),
    ]);
    expect(new Set(errors.map((e) => e.message))).toEqual(
      new Set(["Invalid or expired token"])
    );
    expect(info.mock.calls.map((c) => c[0].reason).sort()).toEqual([
      "client_not_allowed",
      "expired",
      "inactive",
      "service_account",
    ]);
    expect(info).toHaveBeenCalledWith(
      { reason: "client_not_allowed", client_id: "other" },
      "MCP token refused"
    );
  });

  it("lets an introspection failure propagate", async () => {
    const boom = new Error("core down");
    const core = fakeCore(
      {},
      {
        introspectToken: async () => {
          throw boom;
        },
      }
    );
    await expect(make(core).verifyAccessToken(token())).rejects.toBe(boom);
  });
});

describe("authFromInfo", () => {
  it("is undefined without info or auth", () => {
    expect(authFromInfo(undefined)).toBeUndefined();
    expect(
      authFromInfo({ token: "t", clientId: "c", scopes: [] })
    ).toBeUndefined();
  });
});
