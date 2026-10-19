import { getServiceAccessToken } from "../requests/auth/oauth/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { tryHandleRequest } = vi.hoisted(() => ({ tryHandleRequest: vi.fn() }));
vi.mock("../utils/tryHandleRequest.js", () => ({ tryHandleRequest }));

const sentBody = () =>
  new URLSearchParams(tryHandleRequest.mock.calls[0][0].data as string);

beforeEach(() => {
  tryHandleRequest.mockReset();
  tryHandleRequest.mockResolvedValue({ data: { access_token: "t" } });
});

describe("getServiceAccessToken", () => {
  // Service and integration clients hold no scopes; core refuses any asked for.
  it("asks for no scope by default", async () => {
    await getServiceAccessToken();
    expect(sentBody().get("grant_type")).toBe("client_credentials");
    expect(sentBody().has("scope")).toBe(false);
  });

  it("asks for no scope when given none", async () => {
    await getServiceAccessToken([]);
    expect(sentBody().has("scope")).toBe(false);
  });

  it("joins the scopes it is given", async () => {
    await getServiceAccessToken(["openid", "profile"]);
    expect(sentBody().get("scope")).toBe("openid profile");
  });
});
