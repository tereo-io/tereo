// @module-tag int
// @module-tag platform
import { CORE_URL } from "../support/coreUrl.js";
import { describe, expect, it } from "vitest";
import axios from "axios";

describe("root router errors", () => {
  it.each([
    ["GET", "/v1/files/shared/%E0%A4%A"],
    ["GET", "/oauth/upstream/%ZZ/start"],
    ["OPTIONS", "/v1/files/buckets/%ZZ/objects"],
  ])(
    "answers a malformed percent-escape in %s %s with 400",
    async (method, path) => {
      const res = await axios.request({
        method,
        url: `${CORE_URL}${path}`,
        validateStatus: () => true,
      });
      expect(res.status).toBe(400);
      expect(res.data).toEqual({
        error: "invalid_request",
        error_description: "The URL path is malformed",
      });
    }
  );
});
