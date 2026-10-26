// @module-tag unit
// @module-tag files
import { createBucketSchema } from "../../../../../routes/v1/files/buckets/schemas.js";
import { describe, expect, it } from "vitest";

describe("POST /v1/files/buckets", () => {
  describe("createBucketSchema", () => {
    it.each([
      ["a name with spaces", { name: "invalid name with spaces" }],
      ["a name with uppercase letters", { name: "InvalidBucket" }],
      ["a name shorter than 3 characters", { name: "ab" }],
      ["a name longer than 63 characters", { name: "a".repeat(64) }],
      ["a name starting with a hyphen", { name: "-invalid-bucket" }],
      ["a name ending with a hyphen", { name: "invalid-bucket-" }],
      ["a name with special characters", { name: "bucket_name!@#" }],
      [
        "a storage quota over the maximum of 1 TB",
        { name: "bucket-over-quota", storageQuotaBytes: "1099511627777" },
      ],
    ])("rejects %s", (_label, body) => {
      const result = createBucketSchema.safeParse({
        policy: "private",
        ...body,
      });
      expect(result.success).toBe(false);
    });

    it.each([
      ["a name with hyphens", "valid-bucket-name-1a2b"],
      ["a name with numbers", "bucket123-1a2b"],
    ])("accepts %s", (_label, name) => {
      const result = createBucketSchema.safeParse({ name, policy: "private" });
      expect(result.success).toBe(true);
      expect(result.data?.name).toBe(name);
    });
  });
});
