import { sign, verify } from "../../utils/presigning.js";
import { describe, expect, it } from "vitest";

function parseUrl(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("presigned URLs", () => {
  it("signs and verifies a valid read token", () => {
    const { url } = sign({
      bucket: "test-bucket",
      id: "018ebd2a-b2b3-7d1c-a7c2-3e3f9a1c8d00",
      operation: "read",
      expiresInSeconds: 60,
    });
    const params = parseUrl(url);
    const verified = verify({
      bucket: "test-bucket",
      id: "018ebd2a-b2b3-7d1c-a7c2-3e3f9a1c8d00",
      operation: "read",
      expires: params.get("expires")!,
      nonce: params.get("nonce")!,
      v: params.get("v")!,
      sig: params.get("sig")!,
    });
    expect(verified.bucket).toBe("test-bucket");
    expect(verified.id).toBe("018ebd2a-b2b3-7d1c-a7c2-3e3f9a1c8d00");
    expect(verified.operation).toBe("read");
  });

  it("fails verification for a tampered signature", () => {
    const { url } = sign({
      bucket: "test-bucket",
      id: "018ebd2a-b2b3-7d1c-a7c2-3e3f9a1c8d00",
      operation: "read",
      expiresInSeconds: 60,
    });
    const params = parseUrl(url);
    // Flip a middle character. Base64url's final char only encodes 2–4
    // meaningful bits (the rest are padding), so swapping it can decode to
    // the same byte value — a middle flip guarantees a different signature.
    const origSig = params.get("sig")!;
    const mid = Math.floor(origSig.length / 2);
    const swap = origSig[mid] === "A" ? "B" : "A";
    const tamperedSig = origSig.slice(0, mid) + swap + origSig.slice(mid + 1);
    expect(() =>
      verify({
        bucket: "test-bucket",
        id: "018ebd2a-b2b3-7d1c-a7c2-3e3f9a1c8d00",
        operation: "read",
        expires: params.get("expires")!,
        nonce: params.get("nonce")!,
        v: params.get("v")!,
        sig: tamperedSig,
      })
    ).toThrow();
  });

  it("fails verification when operation mismatches", () => {
    const { url } = sign({
      bucket: "test-bucket",
      id: "018ebd2a-b2b3-7d1c-a7c2-3e3f9a1c8d00",
      operation: "read",
      expiresInSeconds: 60,
    });
    const params = parseUrl(url);
    expect(() =>
      verify({
        bucket: "test-bucket",
        id: "018ebd2a-b2b3-7d1c-a7c2-3e3f9a1c8d00",
        operation: "write",
        expires: params.get("expires")!,
        nonce: params.get("nonce")!,
        v: params.get("v")!,
        sig: params.get("sig")!,
      })
    ).toThrow();
  });

  it("rejects expired tokens", () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = String(now - 10);
    const { url } = sign({
      bucket: "test-bucket",
      id: "018ebd2a-b2b3-7d1c-a7c2-3e3f9a1c8d00",
      operation: "read",
      expiresInSeconds: 60,
    });
    const params = parseUrl(url);
    expect(() =>
      verify({
        bucket: "test-bucket",
        id: "018ebd2a-b2b3-7d1c-a7c2-3e3f9a1c8d00",
        operation: "read",
        expires: expired,
        nonce: params.get("nonce")!,
        v: params.get("v")!,
        sig: params.get("sig")!,
      })
    ).toThrow();
  });
});

describe("presigned URL parameter shapes", () => {
  const ID = "018ebd2a-b2b3-7d1c-a7c2-3e3f9a1c8d00";
  const SHARE = "018ebd2a-b2b3-7d1c-a7c2-3e3f9a1c8d01";
  const BY = "018ebd2a-b2b3-7d1c-a7c2-3e3f9a1c8d02";
  const VERSION = "018ebd2a-b2b3-7d1c-a7c2-3e3f9a1c8d03";

  const signed = () =>
    parseUrl(
      sign({
        bucket: "b",
        id: ID,
        operation: "read",
        expiresInSeconds: 60,
        share: SHARE,
        by: BY,
        version: VERSION,
      }).url
    );

  const verifyWith = (
    params: URLSearchParams,
    overrides: Partial<Record<string, string | null>> = {}
  ) =>
    verify({
      bucket: "b",
      id: ID,
      operation: "read",
      expires: params.get("expires")!,
      nonce: params.get("nonce")!,
      v: params.get("v")!,
      sig: params.get("sig")!,
      share: params.get("share"),
      by: params.get("by"),
      version: params.get("version"),
      ...overrides,
    });

  it("verifies a URL carrying share, by and version", () => {
    const verified = verifyWith(signed());
    expect([verified.share, verified.by, verified.version]).toEqual([
      SHARE,
      BY,
      VERSION,
    ]);
  });

  it("refuses segments moved into another parameter", () => {
    const params = signed();
    expect(() =>
      verifyWith(params, { share: `${SHARE}|by=${BY}`, by: null })
    ).toThrow("Invalid signature");
  });

  it("refuses expires and v with trailing junk", () => {
    const params = signed();
    expect(() =>
      verifyWith(params, { expires: `${params.get("expires")}abc` })
    ).toThrow("Invalid signature");
    expect(() => verifyWith(params, { v: `${params.get("v")}.0` })).toThrow(
      "Invalid signature"
    );
  });
});
