import { getTestAccessToken as getAuditToken } from "./support/audit.js";
import { describe, it, expect, beforeAll } from "vitest";
import { getTestAccessToken } from "./support/files.js";
import { HTTP_STATUS } from "./support/files.js";
import { CORE_URL } from "./support/coreUrl.js";

const BASE_URL = CORE_URL;

interface ErrorResponse {
  error?: string;
  error_description?: string;
}

const post = (path: string, body: string, token?: string) =>
  fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });

// Valid JSON of about `bytes` bytes.
const jsonOfSize = (bytes: number) =>
  JSON.stringify({ padding: "x".repeat(bytes) });

describe("JSON request bodies", () => {
  let filesToken: string;
  let auditToken: string;

  beforeAll(async () => {
    filesToken = await getTestAccessToken();
    auditToken = await getAuditToken();
  });

  it("returns 400 invalid_request for malformed JSON on an auth route", async () => {
    const response = await post("/oauth/token", '{"grant_type": ');
    const data = (await response.json()) as ErrorResponse;

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(data.error).toBe("invalid_request");
    expect(data.error_description).toBeDefined();
  });

  it("returns 400 invalid_request for malformed JSON on a files route", async () => {
    const response = await post("/v1/files/buckets", "{not json", filesToken);
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

  it("authenticates before reading a body", async () => {
    // Over every limit, and malformed: unread, neither 413 nor 400.
    const body = `{${"x".repeat(11 * 1024 * 1024)}`;
    for (const path of [
      "/v1/files/buckets",
      "/v1/audit/entries",
      "/v1/audit/entries/batch",
      "/v1/webhooks/events",
      "/v1/notifications",
    ]) {
      const response = await post(path, body);
      expect(response.status, path).toBe(HTTP_STATUS.UNAUTHORIZED);
    }
  });

  it("caps bodies at 1mb", async () => {
    const files = await post(
      "/v1/files/buckets",
      jsonOfSize(1100 * 1024),
      filesToken
    );
    expect(files.status).toBe(HTTP_STATUS.PAYLOAD_TOO_LARGE);
    const audit = await post(
      "/v1/audit/entries",
      jsonOfSize(1100 * 1024),
      auditToken
    );
    expect(audit.status).toBe(HTTP_STATUS.PAYLOAD_TOO_LARGE);
  });

  it("allows up to 10mb for audit batches", async () => {
    const response = await post(
      "/v1/audit/entries/batch",
      jsonOfSize(2 * 1024 * 1024),
      auditToken
    );
    // Parsed, then refused by validation: no `entries`.
    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });
});
