// @module-tag int
// @module-tag auth
// @module-tag security
import { getLockKey } from "../../../../routes/oauth/token/controllers.js";
import type { ClientRecord } from "../../../../utils/db/clients.js";
import { describe, it, expect } from "vitest";

/**
 * Credentials (codes, refresh tokens, share tokens, signatures) must not
 * appear in Redis keys or in exported spans.
 */

const client = { clientId: "some-client" } as ClientRecord;

const SECRET = "c0ffee-credential-value-1234567890";

describe("getLockKey", () => {
  it("the token endpoint's lock key holds a hash of the code or refresh token", () => {
    for (const body of [
      {
        grant_type: "authorization_code",
        code: SECRET,
        redirect_uri: "x",
        client_id: "some-client",
      },
      {
        grant_type: "refresh_token",
        refresh_token: SECRET,
        client_id: "some-client",
      },
    ] as Parameters<typeof getLockKey>[1][]) {
      const key = getLockKey(client, body);
      expect(key).not.toContain(SECRET);
      expect(key).toMatch(/:[0-9a-f]{64}$/);
    }
    const fromCookie = getLockKey(
      client,
      { grant_type: "refresh_token", client_id: "some-client" } as Parameters<
        typeof getLockKey
      >[1],
      SECRET
    );
    expect(fromCookie).not.toContain(SECRET);
  });
});
