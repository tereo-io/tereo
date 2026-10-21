import env from "../../../env.js";
import { expect } from "vitest";

/**
 * The error `/oauth/authorize` sent to the redirect URI (RFC 6749 section
 * 4.1.2.1): a 302 to `redirectUri` carrying `error`, `iss` and, when given,
 * `state`.
 */
export const expectAuthorizeErrorRedirect = (
  response: Response,
  redirectUri: string,
  error: string,
  state?: string
) => {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
  expect(location.searchParams.get("error")).toBe(error);
  expect(location.searchParams.get("iss")).toBe(env.ISSUER);
  if (state !== undefined) {
    expect(location.searchParams.get("state")).toBe(state);
  }
  return location.searchParams;
};
