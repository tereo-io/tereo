import { sendsCors } from "../../middleware/apiCors.js";
import { describe, expect, it } from "vitest";

describe("sendsCors", () => {
  it.each([
    ["GET", "/v1/admin/users"],
    ["POST", "/oauth/token"],
    ["POST", "/oauth/authorize"],
    ["OPTIONS", "/oauth/authorize"],
    ["GET", "/.well-known/openid-configuration"],
    ["GET", "/health"],
  ])("answers %s %s", (method, path) => {
    expect(sendsCors(method, path)).toBe(true);
  });

  it.each([
    ["GET", "/oauth/authorize"],
    ["HEAD", "/oauth/authorize"],
    ["GET", "/OAuth/Authorize/"],
    ["GET", "/"],
    ["GET", "/callback"],
    ["GET", "/assets/index.js"],
    ["GET", "/v1x"],
  ])("leaves out %s %s", (method, path) => {
    expect(sendsCors(method, path)).toBe(false);
  });
});
