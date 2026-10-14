import { loginClientRedirectUris } from "../../definitions/index.js";
import { describe, expect, it } from "vitest";

const UI = "http://localhost:4000";
const CALLBACK = `${UI}/callback`;

describe("loginClientRedirectUris", () => {
  it("is exactly the UI's callback in production", () => {
    expect(
      loginClientRedirectUris(
        ["http://localhost:4001/callback", "https://old.example/callback"],
        "https://core.example",
        true
      )
    ).toEqual(["https://core.example/callback"]);
  });

  it("adds the callback first and keeps other loopback ones outside production", () => {
    expect(
      loginClientRedirectUris(
        [
          "http://localhost:4001/callback",
          "http://127.0.0.1:4000/callback",
          "http://[::1]:4000/callback",
        ],
        UI,
        false
      )
    ).toEqual([
      CALLBACK,
      "http://localhost:4001/callback",
      "http://127.0.0.1:4000/callback",
      "http://[::1]:4000/callback",
    ]);
  });

  it("drops non-loopback callbacks outside production", () => {
    expect(
      loginClientRedirectUris(
        [
          "https://staging.example/callback",
          "http://localhost.evil.example/callback",
          "not a url",
        ],
        UI,
        false
      )
    ).toEqual([CALLBACK]);
  });

  it("does not repeat the callback", () => {
    expect(loginClientRedirectUris([CALLBACK, CALLBACK], UI, false)).toEqual([
      CALLBACK,
    ]);
  });
});
