// @module-tag unit
// @module-tag files
import { describe, expect, it } from "vitest";
import {
  revokePermissionQuerySchema,
  userIdParamSchema,
} from "../../../../../../../../routes/v1/files/buckets/bucket/permissions/permission/schemas.js";

describe("DELETE /v1/files/buckets/:name/permissions/:userId", () => {
  describe("userIdParamSchema", () => {
    it("rejects a userId that is not a UUID", () => {
      const params = { name: "a-bucket", userId: "not-a-uuid" };
      expect(userIdParamSchema.safeParse(params).success).toBe(false);
    });
  });

  describe("revokePermissionQuerySchema", () => {
    it("rejects a revokeShares that isn't true or false", () => {
      const query = { revokeShares: "yes" };
      expect(revokePermissionQuerySchema.safeParse(query).success).toBe(false);
    });
  });
});
