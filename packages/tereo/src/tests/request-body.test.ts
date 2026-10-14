import { HTTP_STATUS } from "./files/utils/test-helpers.js";
import { CORE_URL } from "./utils/coreUrl.js";
import { describe, it, expect } from "vitest";

const BASE_URL = CORE_URL;

interface ErrorResponse {
  error?: string;
  error_description?: string;
}

const post = (path: string, body: string) =>
  fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

describe("JSON request bodies", () => {
  it("returns 400 invalid_request for malformed JSON on an auth route", async () => {
    const response = await post("/oauth/token", '{"grant_type": ');
    const data = (await response.json()) as ErrorResponse;

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(data.error).toBe("invalid_request");
    expect(data.error_description).toBeDefined();
  });

  it("returns 400 invalid_request for malformed JSON on a files route", async () => {
    const response = await post("/v1/files/buckets", "{not json");
    const data = (await response.json()) as ErrorResponse;

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(data.error).toBe("invalid_request");
  });

  it("returns 413 payload_too_large over the auth routes' 10kb limit", async () => {
    const response = await post(
      "/oauth/token",
      JSON.stringify({ grant_type: "x".repeat(11 * 1024) })
    );
    const data = (await response.json()) as ErrorResponse;

    expect(response.status).toBe(HTTP_STATUS.PAYLOAD_TOO_LARGE);
    expect(data.error).toBe("payload_too_large");
  });
});
