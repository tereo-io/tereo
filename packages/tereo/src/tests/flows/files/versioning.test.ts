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
  uploadTestObject,
} from "../../support/files.js";

describe("object versioning", () => {
  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
  let testToken: string;

  beforeAll(async () => {
    testToken = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("Versioning", () => {
    it("lists versions, restores a prior version, and hard-deletes a version", async () => {
      const bucket = await createTestBucket(testToken, {
        policy: "private",
      });

      // Flip versioning on via bucket update. Content-Type must be set
      // explicitly — axios' auto-set can be suppressed when a `headers`
      // config is supplied without one, and the server ignores bodies
      // arriving without an `application/json` content type.
      await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { versioningEnabled: true },
        {
          headers: {
            ...authHeader(testToken),
            "Content-Type": "application/json",
          },
        }
      );

      const key = "versioned.txt";
      const v1 = await uploadTestObject(
        testToken,
        bucket.name,
        key,
        createTestFile("v1", "v1.txt", "text/plain")
      );
      const v2 = await uploadTestObject(
        testToken,
        bucket.name,
        key,
        createTestFile("v2-content", "v2.txt", "text/plain")
      );

      const objectId = v1.id;

      const listRes = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions`,
        { headers: authHeader(testToken) }
      );
      expect(listRes.status).toBe(HTTP_STATUS.OK);
      expect(listRes.data.data).toHaveLength(2);
      const current = listRes.data.data.find(
        (v: { isCurrent: boolean }) => v.isCurrent
      );
      const prior = listRes.data.data.find(
        (v: { isCurrent: boolean }) => !v.isCurrent
      );
      expect(current.etag).toBe(v2.etag);

      // Restore the prior version
      const restoreRes = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions/${prior.versionId}/restore`,
        {},
        { headers: authHeader(testToken) }
      );
      expect(restoreRes.status).toBe(201);

      // The single-version GET carries restoredFromVersionId like the list.
      const restoredRes = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions/${restoreRes.data.versionId}`,
        { headers: authHeader(testToken) }
      );
      expect(restoredRes.status).toBe(HTTP_STATUS.OK);
      expect(restoredRes.data.restoredFromVersionId).toBe(prior.versionId);
      const priorRes = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions/${prior.versionId}`,
        { headers: authHeader(testToken) }
      );
      expect(priorRes.data.restoredFromVersionId).toBeNull();

      // Verify the current download now reflects the old content
      const dl = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/${key}`,
        { headers: authHeader(testToken) }
      );
      expect(dl.data).toBe("v1");

      // Hard-delete the intermediate (non-current) v2
      const delRes = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions/${prior.versionId}`,
        { headers: authHeader(testToken), validateStatus: () => true }
      );
      // prior is now isCurrent=false (restored on top). Deleting it is allowed.
      expect(delRes.status).toBe(HTTP_STATUS.NO_CONTENT);
      const gone = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions/${prior.versionId}`,
        { headers: authHeader(testToken), validateStatus: () => true }
      );
      expect(gone.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });
});
