import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuestsClient } from "../clients/guests.js";

const { inviteGuest, getGuest, extendGuest, issueGuestPasswordSetupLink } =
  vi.hoisted(() => ({
    inviteGuest: vi.fn(),
    getGuest: vi.fn(),
    extendGuest: vi.fn(),
    issueGuestPasswordSetupLink: vi.fn(),
  }));

vi.mock("../requests/auth/index.js", () => ({
  inviteGuest,
  getGuest,
  extendGuest,
  issueGuestPasswordSetupLink,
}));

beforeEach(() => vi.clearAllMocks());

describe("GuestsClient", () => {
  const client = new GuestsClient();

  it("invites with an ISO expiry from a Date", async () => {
    inviteGuest.mockResolvedValue({ user: { id: "u" }, created: true });
    const res = await client.invite({
      email: "g@example.com",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      initialAccess: { type: "password_setup_link", notify: true },
    });
    expect(res).toEqual({ user: { id: "u" }, created: true });
    expect(inviteGuest).toHaveBeenCalledWith({
      email: "g@example.com",
      expiresAt: "2027-01-01T00:00:00.000Z",
      initialAccess: { type: "password_setup_link", notify: true },
    });
  });

  it("passes expiresIn and the other fields through", async () => {
    inviteGuest.mockResolvedValue({ user: {}, created: false });
    const input = {
      email: "g@example.com",
      name: "G",
      roles: ["viewer"],
      expiresIn: 3600,
      initialAccess: { type: "password" as const, password: "pw" },
    };
    await client.invite(input);
    expect(inviteGuest).toHaveBeenCalledWith(input);
  });

  it("gets a guest", async () => {
    getGuest.mockResolvedValue({ id: "u" });
    expect(await client.get("u")).toEqual({ id: "u" });
    expect(getGuest).toHaveBeenCalledWith("u");
  });

  it("extends with an ISO string from a Date, and passes a string as is", async () => {
    extendGuest.mockResolvedValue({ id: "u" });
    await client.extend("u", new Date("2027-02-03T04:05:06Z"));
    expect(extendGuest).toHaveBeenLastCalledWith("u", {
      expiresAt: "2027-02-03T04:05:06.000Z",
    });
    await client.extend("u", "2027-03-01T00:00:00Z");
    expect(extendGuest).toHaveBeenLastCalledWith("u", {
      expiresAt: "2027-03-01T00:00:00Z",
    });
  });

  it("issues a password setup link", async () => {
    issueGuestPasswordSetupLink.mockResolvedValue({ url: "u", expiresAt: "e" });
    expect(await client.issuePasswordSetupLink("u", { notify: true })).toEqual({
      url: "u",
      expiresAt: "e",
    });
    expect(issueGuestPasswordSetupLink).toHaveBeenCalledWith("u", {
      notify: true,
    });
    await client.issuePasswordSetupLink("u");
    expect(issueGuestPasswordSetupLink).toHaveBeenLastCalledWith("u", {});
  });
});
