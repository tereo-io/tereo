import { describe, expect, it } from "vitest";
import { randomBytes } from "crypto";
import {
  aesGcmKek,
  DEV_KEK_ID,
  devKek,
  kekIdOf,
  openSecret,
  resolveKek,
  sealSecret,
} from "../../utils/kek.js";

const envKek = () => {
  const key = randomBytes(32);
  return aesGcmKek(key, kekIdOf(key));
};

describe("KEK envelope", () => {
  it("round-trips a value and records the KEK id", async () => {
    const kek = envKek();
    const sealed = await sealSecret(kek, "TOTP_ENCRYPTION_KEY", "secret");

    expect(sealed).toMatch(new RegExp(`^kek1:${kek.id}:[A-Za-z0-9_-]+$`));
    expect(sealed).not.toContain("secret");
    await expect(
      openSecret(kek, "TOTP_ENCRYPTION_KEY", sealed)
    ).resolves.toEqual({ value: "secret", rewrap: false });
  });

  it("uses a fresh IV for every seal", async () => {
    const kek = envKek();
    const a = await sealSecret(kek, "X", "same");
    const b = await sealSecret(kek, "X", "same");
    expect(a).not.toBe(b);
  });

  it("binds the value to its name", async () => {
    const kek = envKek();
    const sealed = await sealSecret(kek, "CURSOR_SIGNING_KEY_V1", "v");
    await expect(
      openSecret(kek, "FILE_SERVICE_SIGNING_KEY_V1", sealed)
    ).rejects.toThrow(/could not be decrypted/);
  });

  it("refuses a tampered value", async () => {
    const kek = envKek();
    const sealed = await sealSecret(kek, "X", "value");
    const [prefix, id, payload] = sealed.split(":");
    const bytes = Buffer.from(payload, "base64url");
    bytes[bytes.length - 1] ^= 1;
    await expect(
      openSecret(kek, "X", `${prefix}:${id}:${bytes.toString("base64url")}`)
    ).rejects.toThrow(/could not be decrypted/);
  });

  it("refuses a value sealed with another KEK, naming both", async () => {
    const a = envKek();
    const b = envKek();
    const sealed = await sealSecret(a, "X", "value");
    await expect(openSecret(b, "X", sealed)).rejects.toThrow(
      new RegExp(`encrypted with KEK ${a.id}.*has KEK ${b.id}`)
    );
  });

  it("opens a value under the previous KEK and marks it for re-wrapping", async () => {
    const previous = envKek();
    const kek = envKek();
    const sealed = await sealSecret(previous, "X", "rotated");
    await expect(openSecret(kek, "X", sealed, previous)).resolves.toEqual({
      value: "rotated",
      rewrap: true,
    });
    await expect(openSecret(kek, "X", sealed)).rejects.toThrow(
      /encrypted with KEK/
    );
  });

  it("marks plaintext and dev-KEK values for re-wrapping", async () => {
    const kek = envKek();
    await expect(openSecret(kek, "X", "plain")).resolves.toEqual({
      value: "plain",
      rewrap: true,
    });
    const devSealed = await sealSecret(devKek, "X", "dev");
    await expect(openSecret(kek, "X", devSealed)).resolves.toEqual({
      value: "dev",
      rewrap: true,
    });
    // Under the dev KEK itself, a dev-sealed value is current.
    await expect(openSecret(devKek, "X", devSealed)).resolves.toEqual({
      value: "dev",
      rewrap: false,
    });
  });

  it("refuses plaintext and dev-KEK values when told to (production)", async () => {
    const kek = envKek();
    await expect(
      openSecret(kek, "X", "plain", undefined, true)
    ).rejects.toThrow(/stored unencrypted/);
    const devSealed = await sealSecret(devKek, "X", "dev");
    await expect(
      openSecret(kek, "X", devSealed, undefined, true)
    ).rejects.toThrow(/public development KEK/);
    // Values under the current and the previous KEK still open.
    const previous = envKek();
    const sealed = await sealSecret(previous, "X", "old");
    await expect(openSecret(kek, "X", sealed, previous, true)).resolves.toEqual(
      { value: "old", rewrap: true }
    );
  });
});

describe("resolveKek", () => {
  it("uses CORE_KEK when set, with an id derived from it", () => {
    const key = randomBytes(32);
    const kek = resolveKek({
      CORE_KEK: key.toString("base64"),
      NODE_ENV: "production",
    });
    expect(kek.id).toBe(kekIdOf(key));
    expect(kek.id).toMatch(/^env-[0-9a-f]{16}$/);
  });

  it("falls back to the dev KEK outside production only", () => {
    expect(resolveKek({ NODE_ENV: "development" }).id).toBe(DEV_KEK_ID);
    expect(resolveKek({ NODE_ENV: "test" }).id).toBe(DEV_KEK_ID);
    expect(() => resolveKek({ NODE_ENV: "production" })).toThrow(
      /CORE_KEK is required in production/
    );
  });
});
