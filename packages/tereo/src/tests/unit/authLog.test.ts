import { authLog, logAuthFailure, logTokenIssued } from "../../utils/audit.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../utils/logger.js";

describe("authLog levels", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const spies = () => ({
    warn: vi.spyOn(logger, "warn"),
    info: vi.spyOn(logger, "info"),
    debug: vi.spyOn(logger, "debug"),
  });

  it("logs failures and reuse detections at warn", () => {
    const log = spies();
    logAuthFailure("client", "access_denied", "Invalid credentials");
    for (const event of [
      "auth_code_reuse",
      "refresh_token_reuse",
      "auth_code_validation_failure",
      "client_auth_failure",
    ] as const) {
      authLog({ event });
    }
    expect(log.warn).toHaveBeenCalledTimes(5);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ audit: true, error: "access_denied" }),
      "auth_failure"
    );
    expect(log.info).not.toHaveBeenCalled();
  });

  it("logs successes at info", () => {
    const log = spies();
    logTokenIssued("client", "user", "authorization_code", ["openid"], "jti");
    authLog({ event: "auth_success" });
    authLog({ event: "token_refreshed" });
    expect(log.info).toHaveBeenCalledTimes(3);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("keeps per-request lines at debug", () => {
    const log = spies();
    authLog({ event: "http_request", path: "/oauth/token" });
    authLog({ event: "token_introspected" });
    expect(log.debug).toHaveBeenCalledTimes(2);
    expect(log.info).not.toHaveBeenCalled();
  });
});
