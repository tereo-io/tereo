// @module-tag int
// @module-tag platform
import { CORE_URL } from "../support/coreUrl.js";
import { describe, it, expect } from "vitest";
import env from "../../env.js";
import axios from "axios";

const BASE_URL = CORE_URL;
const UI_ORIGIN = new URL(env.UI_BASE_URL).origin;

describe("apiCors", () => {
  it("allows the custom headers the admin UI sends", async () => {
    const response = await axios.options(`${BASE_URL}/v1/files/buckets`, {
      headers: {
        Origin: "http://localhost:4000",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers":
          "idempotency-key,x-organization-id,x-tags",
      },
      validateStatus: () => true,
    });

    const allowed = String(response.headers["access-control-allow-headers"])
      .toLowerCase()
      .split(",")
      .map((h) => h.trim());
    expect(allowed).toEqual(
      expect.arrayContaining(["idempotency-key", "x-organization-id", "x-tags"])
    );
  });

  describe("Credentialed CORS", () => {
    const corsOrigin = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${BASE_URL}${path}`, {
        redirect: "manual",
        ...init,
        headers: { Origin: UI_ORIGIN, ...(init.headers ?? {}) },
      });
      return res.headers.get("access-control-allow-origin");
    };

    it("answers the API and the token endpoint", async () => {
      expect(await corsOrigin("/health")).toBe(UI_ORIGIN);
      expect(
        await corsOrigin("/oauth/token", {
          method: "OPTIONS",
          headers: { "Access-Control-Request-Method": "POST" },
        })
      ).toBe(UI_ORIGIN);
    });

    it("leaves out GET /oauth/authorize and the admin UI's pages", async () => {
      expect(await corsOrigin("/oauth/authorize?client_id=x")).toBeNull();
      expect(await corsOrigin("/OAuth/Authorize/?client_id=x")).toBeNull();
      expect(await corsOrigin("/")).toBeNull();
      expect(await corsOrigin("/callback?code=x")).toBeNull();
    });
  });
});
