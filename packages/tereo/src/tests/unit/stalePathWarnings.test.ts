import { stalePathWarnings } from "../../env.js";
import { describe, expect, it } from "vitest";

describe("stalePathWarnings", () => {
  it.each([
    "https://core.example.com/files",
    "https://core.example.com/files/",
  ])("warns about FILE_SERVICE_PUBLIC_BASE_URL=%s", (url) => {
    expect(stalePathWarnings({ FILE_SERVICE_PUBLIC_BASE_URL: url })).toEqual([
      expect.stringMatching(/^FILE_SERVICE_PUBLIC_BASE_URL.*\/v1\/files/),
    ]);
  });

  it("warns about a UI_BASE_URL ending in /ui", () => {
    expect(
      stalePathWarnings({ UI_BASE_URL: "https://core.example.com/ui/" })
    ).toEqual([expect.stringMatching(/^UI_BASE_URL/)]);
  });

  it("warns about PROVISIONING_FILE without PROVISIONING_PATH", () => {
    expect(
      stalePathWarnings({ PROVISIONING_FILE: "/etc/tereo/provisioning.yaml" })
    ).toEqual([expect.stringMatching(/^PROVISIONING_FILE.*PROVISIONING_PATH/)]);
    expect(
      stalePathWarnings({
        PROVISIONING_FILE: "/etc/tereo/provisioning.yaml",
        PROVISIONING_PATH: "/etc/tereo/provisioning",
      })
    ).toEqual([]);
  });

  it("accepts the current paths and the defaults", () => {
    expect(
      stalePathWarnings({
        FILE_SERVICE_PUBLIC_BASE_URL: "https://core.example.com/v1/files",
        UI_BASE_URL: "https://core.example.com",
      })
    ).toEqual([]);
    expect(stalePathWarnings({})).toEqual([]);
  });

  it("leaves a /ui-named host or deeper path alone", () => {
    expect(
      stalePathWarnings({
        UI_BASE_URL: "https://ui.example.com/admin",
        FILE_SERVICE_PUBLIC_BASE_URL: "https://cdn.example.com/files/v2",
      })
    ).toEqual([]);
  });
});
