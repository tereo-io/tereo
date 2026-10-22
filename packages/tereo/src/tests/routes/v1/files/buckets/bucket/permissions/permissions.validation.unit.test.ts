// @module-tag unit
// @module-tag files
import { describe, expect, it } from "vitest";
import {
  grantPermissionSchema,
  listPermissionsQuerySchema,
} from "../../../../../../../routes/v1/files/buckets/bucket/permissions/schemas.js";

describe("GET and POST /v1/files/buckets/:name/permissions", () => {
  describe("grantPermissionSchema", () => {
    it.each([
      ["an empty userId", ""],
      ["a userId that is not a UUID", "not-a-uuid"],
    ])("rejects %s", (_label, userId) => {
      const result = grantPermissionSchema.safeParse({
        userId,
        canRead: true,
        canWrite: false,
        canDelete: false,
      });
      expect(result.success).toBe(false);
    });

    it("accepts a hex UUID without an RFC variant", () => {
      const userId = "00000000-0000-7001-0000-000000000003";
      const result = grantPermissionSchema.safeParse({ userId, canRead: true });
      expect(result.success).toBe(true);
      expect(result.data?.userId).toBe(userId);
    });
  });

  describe("listPermissionsQuerySchema", () => {
    it("rejects a userId filter that is not a UUID", () => {
      const query = { "filter[userId]": "123" };
      expect(listPermissionsQuerySchema.safeParse(query).success).toBe(false);
    });
  });
});
