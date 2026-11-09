import { sendVerificationErrorMessage } from "./useSendVerificationEmail";
import { describe, expect, it } from "vitest";
import { AxiosError } from "axios";

const failure = (status: number, error: string) =>
  new AxiosError("Request failed", undefined, undefined, undefined, {
    status,
    data: { error },
  } as never);

describe("sendVerificationErrorMessage", () => {
  it("words the per-user limit", () => {
    expect(
      sendVerificationErrorMessage(failure(429, "too_many_requests"))
    ).toBe("Too many verification emails for this user. Try again later.");
  });

  it("words the refusals by code", () => {
    expect(sendVerificationErrorMessage(failure(409, "already_verified"))).toBe(
      "This address is already verified"
    );
    expect(sendVerificationErrorMessage(new Error("x"))).toBe(
      "Failed to send the verification email"
    );
  });
});
