import { clientSignInUrl } from "../../utils/authorization.js";
import { LOGIN_CLIENT } from "../../definitions/index.js";
import { describe, expect, it } from "vitest";
import env from "../../env.js";

describe("clientSignInUrl", () => {
  it("sends core's own client to the UI", () => {
    expect(
      clientSignInUrl({
        clientId: LOGIN_CLIENT.clientId,
        redirectUris: ["https://elsewhere.example.com/callback"],
      })
    ).toBe(`${env.UI_BASE_URL}/`);
  });

  it("uses the origin of the first web redirect URI", () => {
    expect(
      clientSignInUrl({
        clientId: "app",
        redirectUris: [
          "com.example.app:/callback",
          "https://app.example.com/auth/callback",
        ],
      })
    ).toBe("https://app.example.com/");
  });

  it("falls back to the UI for a native app", () => {
    expect(
      clientSignInUrl({
        clientId: "native",
        redirectUris: ["com.example.app:/callback"],
      })
    ).toBe(`${env.UI_BASE_URL}/`);
    expect(clientSignInUrl({ clientId: "none", redirectUris: [] })).toBe(
      `${env.UI_BASE_URL}/`
    );
  });
});
