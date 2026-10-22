// @module-tag int
// @module-tag platform
import { CORE_URL } from "../support/coreUrl.js";
import { describe, it, expect } from "vitest";
import axios from "axios";

const BASE_URL = CORE_URL;

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
});
