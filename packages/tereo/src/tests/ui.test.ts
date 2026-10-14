import { HTTP_STATUS } from "./files/utils/test-helpers.js";
import { RESERVED_PREFIXES } from "../utils/ui.js";
import { CORE_URL } from "./utils/coreUrl.js";
import { describe, it, expect } from "vitest";
import axios from "axios";

// The suite's server serves tests/fixtures/ui-dist (UI_DIST_PATH in testEnv).
const BASE_URL = CORE_URL;
const HTML = { Accept: "text/html,application/xhtml+xml" };
const SHELL = "Tereo UI fixture";

const request = (
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string> = HTML
) =>
  axios.request({
    method,
    url: `${BASE_URL}${path}`,
    headers,
    maxRedirects: 0,
    validateStatus: () => true,
    responseType: "text",
  });
const get = (path: string, headers?: Record<string, string>) =>
  request("GET", path, headers);

describe("Admin UI at /", () => {
  it("serves index.html at /, uncached", async () => {
    const response = await get("/");

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(response.headers["content-type"]).toMatch(/text\/html/);
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.data).toContain(SHELL);
  });

  it.each(["/auth-admin/users/123", "/shared/abc123/report.pdf", "/setup"])(
    "answers the client-side route %s with the app shell",
    async (path) => {
      const response = await get(path);

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data).toContain(SHELL);
    }
  );

  it("caches hashed assets for a year", async () => {
    const response = await get("/assets/index-fixture.js", {});

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(response.headers["cache-control"]).toContain("immutable");
  });

  it("revalidates unhashed files", async () => {
    const response = await get("/favicon.ico", {});

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(response.headers["cache-control"]).toBe("no-cache");
  });

  it("404s a missing asset rather than serving HTML", async () => {
    const response = await get("/assets/missing.js", {});

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(response.headers["content-type"]).not.toMatch(/html/);
  });

  it.each(RESERVED_PREFIXES)(
    "never answers %s/nope with the app shell",
    async (prefix) => {
      const response = await get(`${prefix}/nope`);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers["content-type"]).not.toMatch(/html/);
    }
  );

  it.each(["/assets", "/V1/nope", "/OAuth/nope"])(
    "answers %s with a JSON 404",
    async (path) => {
      const response = await get(path);

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      expect(response.headers["content-type"]).toMatch(/json/);
    }
  );

  it("answers a JSON request to / with a JSON 404", async () => {
    const response = await get("/", { Accept: "application/json" });

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(response.headers["content-type"]).toMatch(/json/);
  });

  it("answers a POST to a UI path with a JSON 404", async () => {
    const response = await request("POST", "/auth-admin");

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(response.headers["content-type"]).toMatch(/json/);
  });

  it("keeps no alias at /ui", async () => {
    const response = await get("/ui/", { Accept: "application/json" });

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it("leaves the API routes to the API", async () => {
    const response = await get("/v1/account", {});

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
  });
});
