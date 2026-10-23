// @module-tag unit
// @module-tag auth
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  CreateUserSchema,
  ListUsersQuerySchema,
} from "../../../../../routes/v1/admin/users/schemas.js";

describe("GET /v1/admin/users", () => {
  describe("ListUsersQuerySchema", () => {
    it.each([
      [
        "more than 100 ids",
        Array.from({ length: 101 }, () => randomUUID()).join(","),
      ],
      ["an id that is not a UUID", `${randomUUID()},nope`],
    ])("rejects %s", (_label, ids) => {
      const result = ListUsersQuerySchema.safeParse({
        "filter[id]": ids,
        "filter[id_op]": "in",
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(["filter[id]"]);
    });
  });
});

describe("POST /v1/admin/users", () => {
  describe("CreateUserSchema", () => {
    it.each([
      [
        "an invalid email format",
        {
          email: "invalid-email",
          password: "Password123!",
          name: "Invalid User",
        },
        ["email"],
      ],
      [
        "userType service_account",
        {
          email: "svc@test.local",
          password: "Password123!@#",
          userType: "service_account",
        },
        ["userType"],
      ],
    ])("rejects %s", (_label, body, path) => {
      const result = CreateUserSchema.safeParse(body);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(path);
    });
  });
});
