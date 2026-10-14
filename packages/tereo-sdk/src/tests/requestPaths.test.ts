import { readdirSync, readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "url";
import { join } from "path";

const REQUESTS = fileURLToPath(new URL("../requests", import.meta.url));

const requestUrls = (): { file: string; url: string }[] =>
  readdirSync(REQUESTS, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) =>
      [
        ...readFileSync(join(REQUESTS, f), "utf8").matchAll(
          /url:\s*(?:urlPath)?["`]([^"`]+)/g
        ),
      ].map((m) => ({ file: f, url: m[1] }))
    );

describe("request paths", () => {
  it("finds the requests", () => {
    expect(requestUrls().length).toBeGreaterThan(40);
  });

  it("call core's API under /v1 and only /oauth and /health at the root", () => {
    const allowed = (url: string) =>
      url === "/health" ||
      url.startsWith("/oauth/") ||
      (url.startsWith("/v1/") && !/^\/v1\/(audit|webhooks)\/v1\//.test(url));
    expect(requestUrls().filter(({ url }) => !allowed(url))).toEqual([]);
  });
});
