import { contentDisposition } from "../../routes/v1/files/buckets/bucket/objects/utils.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObjectAndGetId,
} from "./utils/test-helpers.js";

const CYRILLIC = "Отчёт.zip";
const EMOJI = "report 📦 (final).pdf";

const encodedName = (header: string): string =>
  decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(header)![1]);

describe("contentDisposition", () => {
  it("gives an ASCII fallback and the real name in filename*", () => {
    const value = contentDisposition("attachment", CYRILLIC);
    expect(value).toMatch(/^attachment; filename="_____\.zip"; filename\*=/);
    expect(encodedName(value)).toBe(CYRILLIC);
  });

  it("encodes RFC 5987 specials and keeps the value Latin-1", () => {
    const value = contentDisposition("inline", EMOJI);
    expect(value).not.toMatch(/[^\x20-\x7e]/);
    expect(value).toContain("%28final%29");
    expect(encodedName(value)).toBe(EMOJI);
  });

  it("neutralises quotes, backslashes, controls and lone surrogates", () => {
    const value = contentDisposition("attachment", 'a"b\\c\r\nd\uD800.txt');
    expect(value).toContain('filename="a_b_c__d_.txt"');
  });
});

describe("downloads with non-Latin-1 filenames", () => {
  let token: string;
  let bucket: { name: string };
  let objectId: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    token = await getTestAccessToken();
    bucket = await createTestBucket(token, { policy: "private" });
    objectId = await uploadTestObjectAndGetId(
      token,
      bucket.name,
      "docs/report.pdf",
      createTestFile("pdf-bytes", "report.pdf", "application/pdf")
    );
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("serves an archive named in Cyrillic", async () => {
    const created = await axios.post<{ url: string }>(
      `${BASE_URL}/buckets/${bucket.name}/archives`,
      { prefix: "docs/", filename: CYRILLIC },
      { headers: auth() }
    );
    const res = await axios.get(created.data.url, {
      responseType: "arraybuffer",
      validateStatus: () => true,
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(encodedName(res.headers["content-disposition"])).toBe(CYRILLIC);
  });

  it("serves a signed download with an emoji ?filename=", async () => {
    const presign = await axios.post<{ url: string }>(
      `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/presign`,
      { operation: "read", expiresInSeconds: 60 },
      { headers: auth() }
    );
    const url = new URL(presign.data.url);
    url.searchParams.set("filename", EMOJI);
    const res = await axios.get(url.toString(), { validateStatus: () => true });
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(encodedName(res.headers["content-disposition"])).toBe(EMOJI);
  });

  it.each([CYRILLIC, EMOJI])(
    "probes and downloads a share with urlFilename %s",
    async (urlFilename) => {
      const share = await axios.post<{ url: string }>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId, urlFilename },
        { headers: auth() }
      );
      const probe = await axios.head(share.data.url, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      expect(probe.status).toBe(HTTP_STATUS.OK);
      expect(encodedName(probe.headers["content-disposition"])).toBe(
        urlFilename
      );

      const res = await axios.get(share.data.url, {
        validateStatus: () => true,
      });
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(encodedName(res.headers["content-disposition"])).toBe(urlFilename);
    }
  );

  it("serves an archive share named in Cyrillic", async () => {
    const share = await axios.post<{ url: string }>(
      `${BASE_URL}/buckets/${bucket.name}/shares`,
      { kind: "ARCHIVE", prefix: "docs/", archiveFilename: CYRILLIC },
      { headers: auth(), validateStatus: () => true }
    );
    expect(share.status).toBe(HTTP_STATUS.CREATED);
    const probe = await axios.head(share.data.url, {
      maxRedirects: 0,
      validateStatus: () => true,
    });
    expect(probe.status).toBe(HTTP_STATUS.OK);
    expect(encodedName(probe.headers["content-disposition"])).toBe(CYRILLIC);
    const res = await axios.get(share.data.url, {
      responseType: "arraybuffer",
      validateStatus: () => true,
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(encodedName(res.headers["content-disposition"])).toBe(CYRILLIC);
  });
});
