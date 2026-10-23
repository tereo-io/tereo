// @module-tag int
// @module-tag auth
// @module-tag race

import { createTestUser, enableTotp } from "../../../../support/auth/users.js";
import { BASE_URL, HTTP_STATUS } from "../../../../support/auth/constants.js";
import { getUiAccessTokenForUser } from "../../../../support/auth/login.js";
import { generateTotpCode } from "../../../../support/auth/crypto.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { describe, it, expect } from "vitest";

interface TotpSetupResponse {
  secret?: string;
  qrCodeUri?: string;
  setupToken?: string;
  expiresAt?: string;
  [key: string]: unknown;
}

interface ErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
  [key: string]: unknown;
}

describe("DELETE /v1/account/totp, POST /v1/account/totp/recovery-codes and POST /v1/account/totp/setup/verify", () => {
  const TOO_MANY_REQUESTS = 429;
  const MAX_FAILURES = 5;

  const wrongCode = (secret: string) =>
    String((Number(generateTotpCode(secret)) + 500_000) % 1_000_000).padStart(
      6,
      "0"
    );

  // Enabled with the previous step's code when the test spends two more.
  const userWithTotp = async (enableStepOffset = 0) => {
    const user = await createTestUser();
    const token = await getUiAccessTokenForUser(user);
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const setup = (await (
      await fetch(`${BASE_URL}/v1/account/totp/setup`, {
        method: "POST",
        headers,
      })
    ).json()) as TotpSetupResponse;
    const verify = await fetch(`${BASE_URL}/v1/account/totp/setup/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        setupToken: setup.setupToken,
        totpCode: generateTotpCode(setup.secret!, enableStepOffset),
      }),
    });
    expect(verify.status).toBe(HTTP_STATUS.OK);
    return { user, headers, secret: setup.secret! };
  };

  const disable = (headers: Record<string, string>, totpCode: string) =>
    fetch(`${BASE_URL}/v1/account/totp`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ totpCode }),
    });

  const expectLockedOut = async (response: Response) => {
    expect(response.status).toBe(TOO_MANY_REQUESTS);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBe("too_many_requests");
  };

  it("locks DELETE /account/totp after repeated wrong codes, even for a correct one", async () => {
    const { user, headers, secret } = await userWithTotp();

    for (let i = 0; i < MAX_FAILURES; i++) {
      const response = await disable(headers, wrongCode(secret));
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    }

    await expectLockedOut(await disable(headers, generateTotpCode(secret)));

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(stored.totpEnabled).toBe(true);
  });

  it("counts failures across the account TOTP routes", async () => {
    const { headers, secret } = await userWithTotp();

    for (let i = 0; i < MAX_FAILURES; i++) {
      const response =
        i % 2 === 0
          ? await disable(headers, wrongCode(secret))
          : await fetch(`${BASE_URL}/v1/account/totp/recovery-codes`, {
              method: "POST",
              headers,
              body: JSON.stringify({ totpCode: wrongCode(secret) }),
            });
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    }

    await expectLockedOut(
      await fetch(`${BASE_URL}/v1/account/totp/recovery-codes`, {
        method: "POST",
        headers,
        body: JSON.stringify({ totpCode: generateTotpCode(secret) }),
      })
    );
  });

  it("locks POST /account/totp/setup/verify after repeated wrong codes", async () => {
    const user = await createTestUser();
    const token = await getUiAccessTokenForUser(user);
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const setup = (await (
      await fetch(`${BASE_URL}/v1/account/totp/setup`, {
        method: "POST",
        headers,
      })
    ).json()) as TotpSetupResponse;
    const verify = (totpCode: string) =>
      fetch(`${BASE_URL}/v1/account/totp/setup/verify`, {
        method: "POST",
        headers,
        body: JSON.stringify({ setupToken: setup.setupToken, totpCode }),
      });

    for (let i = 0; i < MAX_FAILURES; i++) {
      const response = await verify(wrongCode(setup.secret!));
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    }

    await expectLockedOut(await verify(generateTotpCode(setup.secret!)));
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(stored.totpEnabled).toBe(false);
  });

  it("locks out only the user whose codes failed", async () => {
    const locked = await userWithTotp();
    const other = await userWithTotp();

    for (let i = 0; i < MAX_FAILURES; i++) {
      await disable(locked.headers, wrongCode(locked.secret));
    }
    await expectLockedOut(
      await disable(locked.headers, generateTotpCode(locked.secret))
    );

    const response = await disable(
      other.headers,
      generateTotpCode(other.secret, 1)
    );
    expect(response.status).toBe(HTTP_STATUS.OK);
  });

  it("resets the count after a correct code", async () => {
    const { headers, secret } = await userWithTotp(-1);
    const regenerate = (totpCode: string) =>
      fetch(`${BASE_URL}/v1/account/totp/recovery-codes`, {
        method: "POST",
        headers,
        body: JSON.stringify({ totpCode }),
      });

    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      expect((await regenerate(wrongCode(secret))).status).toBe(
        HTTP_STATUS.BAD_REQUEST
      );
    }
    expect((await regenerate(generateTotpCode(secret))).status).toBe(
      HTTP_STATUS.OK
    );
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      expect((await regenerate(wrongCode(secret))).status).toBe(
        HTTP_STATUS.BAD_REQUEST
      );
    }
    expect((await disable(headers, generateTotpCode(secret, 1))).status).toBe(
      HTTP_STATUS.OK
    );
  });

  it("lets no more than the limit through when wrong codes arrive at once", async () => {
    const user = await createTestUser();
    // Disabling 2FA is for core's UI only.
    const token = await getUiAccessTokenForUser(user);
    const secret = await enableTotp(user.id);

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        fetch(`${BASE_URL}/v1/account/totp`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ totpCode: wrongCode(secret) }),
        })
      )
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === HTTP_STATUS.BAD_REQUEST)).toHaveLength(
      MAX_FAILURES
    );
    expect(statuses.filter((s) => s === TOO_MANY_REQUESTS)).toHaveLength(
      20 - MAX_FAILURES
    );
  });
});
