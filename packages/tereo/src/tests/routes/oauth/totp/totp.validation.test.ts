// @module-tag int
// @module-tag auth
import { describe, it, expect } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
  OAUTH_ERRORS,
  startTotpSetup,
} from "../../../support/auth.js";

interface TotpVerifyResponse {
  redirect_url?: string;
  error?: string;
  error_description?: string;
}

interface TotpSetupResponse {
  secret?: string;
  qrCodeUri?: string;
  setupToken?: string;
  expiresAt?: string;
  error?: string;
  error_description?: string;
}

interface TotpSetupVerifyResponse {
  success?: boolean;
  recoveryCodes?: string[];
  message?: string;
  error?: string;
  error_description?: string;
}

describe("/oauth/totp", () => {
  describe("OAuth TOTP Endpoints", () => {
    describe("POST /oauth/totp/verify", () => {
      it("should return 400 with invalid_request error without session token", async () => {
        const response = await fetch(`${BASE_URL}/oauth/totp/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            totp_code: "123456",
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

        const data = (await response.json()) as TotpVerifyResponse;
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      });

      it("should return 400 with invalid_request error without TOTP code", async () => {
        const response = await fetch(`${BASE_URL}/oauth/totp/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_token: "invalid-session-token",
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

        const data = (await response.json()) as TotpVerifyResponse;
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      });

      it("should return 400 with invalid_session error for invalid session token", async () => {
        const response = await fetch(`${BASE_URL}/oauth/totp/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_token: "nonexistent-session-token",
            totp_code: "123456",
          }),
        });

        const data = (await response.json()) as TotpVerifyResponse;

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_SESSION);
      });

      it("should return 400 with invalid_request error for invalid TOTP code format (5 digits)", async () => {
        const response = await fetch(`${BASE_URL}/oauth/totp/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_token: "some-session",
            totp_code: "12345", // Only 5 digits - must be 6
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

        const data = (await response.json()) as TotpVerifyResponse;
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      });

      it("should return 400 with invalid_request error for non-numeric TOTP code", async () => {
        const response = await fetch(`${BASE_URL}/oauth/totp/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_token: "some-session",
            totp_code: "abcdef",
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

        const data = (await response.json()) as TotpVerifyResponse;
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      });

      it("should return 400 with invalid_request error for TOTP code with 7 digits", async () => {
        const response = await fetch(`${BASE_URL}/oauth/totp/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_token: "some-session",
            totp_code: "1234567", // 7 digits - must be 6
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });
    });

    describe("POST /oauth/totp/recovery", () => {
      it("should return 400 with invalid_request error without session token", async () => {
        const response = await fetch(`${BASE_URL}/oauth/totp/recovery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recovery_code: "ABCD-EFGH-IJKL",
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

        const data = (await response.json()) as TotpVerifyResponse;
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      });

      it("should return 400 with invalid_request error without recovery code", async () => {
        const response = await fetch(`${BASE_URL}/oauth/totp/recovery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_token: "invalid-session-token",
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

        const data = (await response.json()) as TotpVerifyResponse;
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      });

      it("should return 400 with invalid_session error for invalid session token", async () => {
        const response = await fetch(`${BASE_URL}/oauth/totp/recovery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_token: "nonexistent-session-token",
            recovery_code: "ABCD-EFGH-IJKL",
          }),
        });

        const data = (await response.json()) as TotpVerifyResponse;

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_SESSION);
      });

      it("should return 400 with invalid_request error for empty recovery code", async () => {
        const response = await fetch(`${BASE_URL}/oauth/totp/recovery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_token: "some-session",
            recovery_code: "",
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });
    });

    describe("POST /oauth/totp/setup", () => {
      it("returns 400 without a grant", async () => {
        const response = await startTotpSetup({});

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        const data = (await response.json()) as TotpSetupResponse;
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      });
    });

    describe("POST /oauth/totp/setup/verify", () => {
      it("should return 400 with invalid_request error without setup_token", async () => {
        const response = await fetch(`${BASE_URL}/oauth/totp/setup/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            totp_code: "123456",
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

        const data = (await response.json()) as TotpSetupVerifyResponse;
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      });

      it("should return 400 with invalid_request error without totp_code", async () => {
        const response = await fetch(`${BASE_URL}/oauth/totp/setup/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            setup_token: "invalid-setup-token",
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

        const data = (await response.json()) as TotpSetupVerifyResponse;
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      });

      it("should return 400 with invalid_setup_token error for invalid setup_token", async () => {
        const response = await fetch(`${BASE_URL}/oauth/totp/setup/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            setup_token: "nonexistent-setup-token",
            totp_code: "123456",
          }),
        });

        const data = (await response.json()) as TotpSetupVerifyResponse;

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_SETUP_TOKEN);
      });

      it("should return 400 with invalid_request error for invalid TOTP code format (5 digits)", async () => {
        const response = await fetch(`${BASE_URL}/oauth/totp/setup/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            setup_token: "some-token",
            totp_code: "12345", // Only 5 digits - must be 6
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

        const data = (await response.json()) as TotpSetupVerifyResponse;
        expect(data.error).toBe(OAUTH_ERRORS.INVALID_REQUEST);
      });

      it("should return 400 with invalid_request error for empty totp_code", async () => {
        const response = await fetch(`${BASE_URL}/oauth/totp/setup/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            setup_token: "some-token",
            totp_code: "",
          }),
        });

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });
    });
  });
});
