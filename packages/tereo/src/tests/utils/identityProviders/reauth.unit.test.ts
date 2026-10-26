// @module-tag unit
// @module-tag auth
import type { NormalizedIdentity } from "../../../utils/identityProviders/types.js";
import { describe, expect, it } from "vitest";
import {
  upstreamAuthTime,
  upstreamReauth,
} from "../../../utils/identityProviders/reauth.js";

const startedAt = new Date("2026-10-21T12:00:00Z");

const now = new Date("2026-10-21T12:00:20Z");

const secondsBefore = (s: number) => new Date(startedAt.getTime() - s * 1000);

const identity = (authTime: Date | null): NormalizedIdentity => ({
  subject: "sub",
  email: null,
  emailVerified: false,
  name: null,
  firstName: null,
  lastName: null,
  hostedDomain: null,
  authTime,
});

describe("upstreamReauth", () => {
  it("asks for nothing by default", () => {
    expect(upstreamReauth({ prompt: null, maxAge: null })).toEqual({
      promptLogin: false,
      maxAge: null,
    });
  });

  it("forwards prompt=login from a prompt list", () => {
    expect(upstreamReauth({ prompt: "consent login", maxAge: null })).toEqual({
      promptLogin: true,
      maxAge: null,
    });
  });

  it("sends max_age=0 as prompt=login too", () => {
    expect(upstreamReauth({ prompt: null, maxAge: 0 })).toEqual({
      promptLogin: true,
      maxAge: 0,
    });
  });

  it("keeps a positive max_age apart from prompt", () => {
    expect(upstreamReauth({ prompt: null, maxAge: 300 })).toEqual({
      promptLogin: false,
      maxAge: 300,
    });
  });
});

describe("upstreamAuthTime", () => {
  const none = { promptLogin: false, maxAge: null };

  it("takes the provider's auth_time, however old, when nothing was asked", () => {
    const old = secondsBefore(86_400);
    expect(upstreamAuthTime(identity(old), none, startedAt, now)).toEqual(old);
  });

  it("uses now when the provider sends none and nothing was asked", () => {
    expect(upstreamAuthTime(identity(null), none, startedAt, now)).toEqual(now);
  });

  it("caps an auth_time in the future at now", () => {
    const ahead = new Date(now.getTime() + 5000);
    expect(upstreamAuthTime(identity(ahead), none, startedAt, now)).toEqual(
      now
    );
  });

  it("accepts an auth_time within max_age of the round trip's start", () => {
    const reauth = { promptLogin: false, maxAge: 300 };
    const t = secondsBefore(290);
    expect(upstreamAuthTime(identity(t), reauth, startedAt, now)).toEqual(t);
  });

  it("refuses an auth_time older than max_age allows", () => {
    const reauth = { promptLogin: false, maxAge: 300 };
    expect(
      upstreamAuthTime(identity(secondsBefore(400)), reauth, startedAt, now)
    ).toBeNull();
  });

  it("refuses a missing auth_time under max_age alone", () => {
    const reauth = { promptLogin: false, maxAge: 300 };
    expect(upstreamAuthTime(identity(null), reauth, startedAt, now)).toBeNull();
  });

  it("uses now for a missing auth_time once prompt=login was sent", () => {
    const reauth = { promptLogin: true, maxAge: 0 };
    expect(upstreamAuthTime(identity(null), reauth, startedAt, now)).toEqual(
      now
    );
  });

  it("refuses, under prompt=login, a sign-in from before the round trip", () => {
    const reauth = { promptLogin: true, maxAge: null };
    expect(
      upstreamAuthTime(identity(secondsBefore(600)), reauth, startedAt, now)
    ).toBeNull();
  });

  it("allows the provider's clock to run up to 30 seconds behind", () => {
    const reauth = { promptLogin: true, maxAge: 0 };
    const t = secondsBefore(25);
    expect(upstreamAuthTime(identity(t), reauth, startedAt, now)).toEqual(t);
    expect(
      upstreamAuthTime(identity(secondsBefore(35)), reauth, startedAt, now)
    ).toBeNull();
  });
});
