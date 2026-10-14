import { decryptBuffer, encryptBuffer } from "../utils/blobCrypto.js";
import { openBlobRangeStream } from "../../utils/storage.js";
import { describe, expect, it } from "vitest";
import { Readable } from "stream";
import fs from "fs/promises";
import crypto from "crypto";
import path from "path";
import os from "os";
import {
  BLOB_MAGIC_V1,
  aadForBlobHash,
  aadForUploadId,
  createDecryptStream,
  createEncryptStream,
  createMultipartPartDecryptStream,
  createMultipartPartEncryptStream,
  generateDek,
  generateStagingDek,
  unwrapDek,
  wrapDek,
} from "../../utils/encryption.js";

async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

describe("envelope encryption", () => {
  it("roundtrips a buffer with AAD-bound DEK wrap", () => {
    const plain = Buffer.from("hello file service");
    const hash = sha256(plain);
    const { cipher, key } = encryptBuffer(plain, hash);
    expect(cipher.subarray(0, BLOB_MAGIC_V1.length).equals(BLOB_MAGIC_V1)).toBe(
      true
    );
    const decrypted = decryptBuffer(cipher, key, hash);
    expect(decrypted.equals(plain)).toBe(true);
  });

  it("wrap+unwrap DEK preserves key material when AAD matches", () => {
    const dek = generateDek();
    const aad = aadForBlobHash(sha256(Buffer.from("anything")));
    const wrapped = wrapDek(dek, 1, aad);
    const unwrapped = unwrapDek(wrapped, 1, aad);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  it("unwrap fails when AAD differs (cross-row swap defense)", () => {
    const dek = generateDek();
    const wrapped = wrapDek(dek, 1, aadForBlobHash(sha256(Buffer.from("a"))));
    expect(() =>
      unwrapDek(wrapped, 1, aadForBlobHash(sha256(Buffer.from("b"))))
    ).toThrow();
  });

  it("decryptBuffer with the wrong blob hash fails", () => {
    const plain = Buffer.from("the right plaintext");
    const hash = sha256(plain);
    const { cipher, key } = encryptBuffer(plain, hash);
    const wrong = sha256(Buffer.from("not the same plaintext"));
    expect(() => decryptBuffer(cipher, key, wrong)).toThrow();
  });

  it("ciphertext differs per call even for identical plaintext", () => {
    const plain = Buffer.from("dedupable plaintext");
    const hash = sha256(plain);
    const a = encryptBuffer(plain, hash);
    const b = encryptBuffer(plain, hash);
    expect(a.cipher.equals(b.cipher)).toBe(false);
    expect(a.key.iv.equals(b.key.iv)).toBe(false);
  });

  it("streaming cipher produces bytes decryptable by the stream decipher", async () => {
    const plain = crypto.randomBytes(64 * 1024);
    const hash = sha256(plain);
    const { stream: encStream, finalize } = createEncryptStream();
    const source = Readable.from([plain]);

    const cipher = await collectStream(source.pipe(encStream));
    expect(cipher.subarray(0, BLOB_MAGIC_V1.length).equals(BLOB_MAGIC_V1)).toBe(
      true
    );

    const key = finalize(hash);
    const decStream = createDecryptStream(key, hash);
    const out = await collectStream(Readable.from([cipher]).pipe(decStream));
    expect(out.equals(plain)).toBe(true);
  });

  it("streaming decipher rejects a missing magic header", async () => {
    const plain = Buffer.from("payload");
    const hash = sha256(plain);
    const { stream: encStream, finalize } = createEncryptStream();
    const cipher = await collectStream(Readable.from([plain]).pipe(encStream));
    const key = finalize(hash);
    // Strip the magic to simulate a tampered/legacy file.
    const noMagic = cipher.subarray(BLOB_MAGIC_V1.length);
    const decStream = createDecryptStream(key, hash);
    await expect(
      collectStream(Readable.from([noMagic]).pipe(decStream))
    ).rejects.toThrow();
  });

  it("streaming decipher rejects a wrong blob hash", async () => {
    const plain = Buffer.from("payload");
    const hash = sha256(plain);
    const { stream: encStream, finalize } = createEncryptStream();
    await collectStream(Readable.from([plain]).pipe(encStream));
    const key = finalize(hash);
    const wrong = sha256(Buffer.from("not-the-payload"));
    expect(() => createDecryptStream(key, wrong)).toThrow();
  });

  it("tampered ciphertext fails to decrypt", () => {
    const plain = Buffer.from("untampered");
    const hash = sha256(plain);
    const { cipher, key } = encryptBuffer(plain, hash);
    const tampered = Buffer.from(cipher);
    // Flip a byte in the body (after the magic header).
    tampered[BLOB_MAGIC_V1.length + 1] ^= 0x01;
    expect(() => decryptBuffer(tampered, key, hash)).toThrow();
  });

  it("zero-byte plaintext roundtrips through the streaming pipeline", async () => {
    const plain = Buffer.alloc(0);
    const hash = sha256(plain);
    const { stream: encStream, finalize } = createEncryptStream();
    const cipher = await collectStream(Readable.from([plain]).pipe(encStream));
    const key = finalize(hash);
    const decStream = createDecryptStream(key, hash);
    const out = await collectStream(Readable.from([cipher]).pipe(decStream));
    expect(out.length).toBe(0);
  });
});

describe("multipart staging DEK", () => {
  it("part encrypt/decrypt roundtrip under the same DEK", async () => {
    const uploadId = crypto.randomUUID();
    const { wrapped, masterKeyVersion } = generateStagingDek(uploadId);
    const dek = unwrapDek(wrapped, masterKeyVersion, aadForUploadId(uploadId));

    const plain = crypto.randomBytes(48 * 1024);
    const enc = createMultipartPartEncryptStream(dek);
    const cipher = await collectStream(Readable.from([plain]).pipe(enc));

    const dec = createMultipartPartDecryptStream(dek);
    const out = await collectStream(Readable.from([cipher]).pipe(dec));
    expect(out.equals(plain)).toBe(true);
  });

  it("staging DEK unwrap fails with wrong upload id (AAD mismatch)", () => {
    const uploadId = crypto.randomUUID();
    const { wrapped, masterKeyVersion } = generateStagingDek(uploadId);
    expect(() =>
      unwrapDek(
        wrapped,
        masterKeyVersion,
        aadForUploadId("different-upload-id")
      )
    ).toThrow();
  });

  it("multiple parts under the same DEK all roundtrip independently", async () => {
    const uploadId = crypto.randomUUID();
    const { wrapped, masterKeyVersion } = generateStagingDek(uploadId);
    const dek = unwrapDek(wrapped, masterKeyVersion, aadForUploadId(uploadId));

    const parts = [
      crypto.randomBytes(16 * 1024),
      crypto.randomBytes(32 * 1024),
      crypto.randomBytes(8 * 1024),
    ];
    const ciphers = await Promise.all(
      parts.map((p) =>
        collectStream(
          Readable.from([p]).pipe(createMultipartPartEncryptStream(dek))
        )
      )
    );
    // Each part has its own IV, so ciphertexts must differ even for identical
    // plaintext under the same key.
    expect(ciphers[0].equals(ciphers[1])).toBe(false);
    const out = await Promise.all(
      ciphers.map((c) =>
        collectStream(
          Readable.from([c]).pipe(createMultipartPartDecryptStream(dek))
        )
      )
    );
    for (let i = 0; i < parts.length; i++) {
      expect(out[i].equals(parts[i])).toBe(true);
    }
  });
});

describe("range decryption", () => {
  it("decrypts any byte range from its offset, as the whole-blob decrypt does", async () => {
    const plain = crypto.randomBytes(1000);
    const hash = sha256(plain);
    const { stream, finalize } = createEncryptStream();
    const cipher = await collectStream(Readable.from([plain]).pipe(stream));
    const key = finalize(hash);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "range-"));
    const fsPath = path.join(dir, "blob");
    await fs.writeFile(fsPath, cipher);
    try {
      for (const [start, end] of [
        [0, 0],
        [0, 15],
        [15, 16],
        [16, 31],
        [17, 500],
        [999, 999],
        [3, 999],
      ]) {
        const out = await collectStream(
          await openBlobRangeStream(
            { fsPath, keyMaterial: key },
            hash,
            start,
            end
          )
        );
        expect([
          start,
          end,
          out.equals(plain.subarray(start, end + 1)),
        ]).toEqual([start, end, true]);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a file without the blob header", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "range-"));
    const fsPath = path.join(dir, "blob");
    await fs.writeFile(fsPath, Buffer.alloc(64));
    const plain = Buffer.from("x");
    const { key } = encryptBuffer(plain, sha256(plain));
    try {
      await expect(
        openBlobRangeStream({ fsPath, keyMaterial: key }, sha256(plain), 0, 0)
      ).rejects.toThrow(/magic header/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
