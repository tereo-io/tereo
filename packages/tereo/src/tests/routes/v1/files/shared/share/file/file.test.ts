// @module-tag int
// @module-tag files
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
} from "../../../../../../support/files.js";

describe("GET and HEAD /v1/files/shared/:token/:filename", () => {
  interface ShareResponse {
    id: string;
    token: string;
    bucketId: number;
    kind: "OBJECT" | "ARCHIVE";
    url: string;
    urlFilename: string | null;
    objectId: string | null;
    versionId: string | null;
    archiveRequestId: string | null;
    hasPassword: boolean;
    expiresAt: string | null;
    maxDownloads: number | null;
    downloadCount: number;
    revokedAt: string | null;
    status: "active" | "revoked" | "expired" | "exhausted";
    object: { id: string; objectKey: string } | null;
    archiveRequest: { filename: string } | null;
  }
  let token: string;
  let bucket: { id: number; name: string };
  let objectId: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
    bucket = await createTestBucket(token, { policy: "private" });
    objectId = await uploadTestObjectAndGetId(
      token,
      bucket.name,
      "report.pdf",
      createTestFile("pdf-bytes", "report.pdf", "application/pdf")
    );
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("HEAD status probe", () => {
    async function createShare(body: Record<string, unknown>) {
      const res = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        body,
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      return res.data;
    }

    async function downloadCount(id: string): Promise<number> {
      const res = await axios.get<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${id}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      return res.data.downloadCount;
    }

    it("answers the cosmetic filename form the same way", async () => {
      const share = await createShare({
        kind: "OBJECT",
        objectId,
        urlFilename: "custom-name.pdf",
      });
      const probe = await axios.head(share.url, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      expect(probe.status).toBe(HTTP_STATUS.OK);
      expect(probe.headers["content-disposition"]).toContain("custom-name.pdf");
      expect(probe.headers["x-share-downloads-remaining"]).toBeUndefined();
      expect(probe.headers["x-share-expires-at"]).toBe(share.expiresAt);
      expect(await downloadCount(share.id)).toBe(0);
    });
  });

  describe("urlFilename", () => {
    it("renders urlFilename as a cosmetic suffix, ignored by the route", async () => {
      const res = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId, urlFilename: "custom-name.pdf" },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      expect(res.data.url).toContain("/custom-name.pdf");
      // The route ignores the trailing segment — a different suffix still
      // resolves the same share.
      const mangled = res.data.url.replace("custom-name.pdf", "anything.bin");
      const dl = await axios.get(mangled, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      expect(dl.status).toBe(302);
    });
  });
});
