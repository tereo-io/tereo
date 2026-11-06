import { describe, expect, it } from "vitest";
import { AxiosError } from "axios";
import {
  extendGuestErrorMessage,
  inviteGuestErrorMessage,
  passwordLinkErrorMessage,
  promoteGuestErrorMessage,
} from "./guestErrors";

const coreError = (error: string, error_description = "core says") =>
  new AxiosError("Request failed", undefined, undefined, undefined, {
    status: 409,
    data: { error, error_description },
  } as never);

describe("guest error messages", () => {
  it("words the invite refusals", () => {
    expect(inviteGuestErrorMessage(coreError("email_unavailable"))).toBe(
      "This email can't be invited. Ask an administrator."
    );
    expect(inviteGuestErrorMessage(coreError("guest_unassigned"))).toMatch(
      /belongs to no organization/
    );
  });

  it("words a link refused for a guest who set a password", () => {
    expect(passwordLinkErrorMessage(coreError("guest_has_password"))).toMatch(
      /already set a password/
    );
  });

  it("words a promotion refused before the guest chose a password", () => {
    expect(
      promoteGuestErrorMessage(coreError("password_not_user_set"))
    ).toMatch(/not chosen their own password/);
  });

  it("words an extension outside the caller's organizations", () => {
    expect(
      extendGuestErrorMessage(coreError("organization_not_permitted"))
    ).toMatch(/only in an organization you belong to/);
  });

  it("falls back to core's description", () => {
    expect(passwordLinkErrorMessage(coreError("other", "Nope"))).toBe("Nope");
  });
});
