// @module-tag unit
// @module-tag auth
import { SetGroupRolesSchema } from "../../../../../routes/v1/admin/groups/group/roles/schemas.js";
import { UpdateGroupSchema } from "../../../../../routes/v1/admin/groups/group/schemas.js";
import { describe, expect, it } from "vitest";
import {
  AddMembersSchema,
  ListMembersQuerySchema,
} from "../../../../../routes/v1/admin/groups/group/members/schemas.js";
import {
  CreateGroupSchema,
  ListGroupsQuerySchema,
} from "../../../../../routes/v1/admin/groups/schemas.js";

const ID = "00000000-0000-7000-8000-000000000000";
const ids = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`
  );
const valid = { slug: "support-team", name: "Support" };

describe("group schemas", () => {
  describe("CreateGroupSchema", () => {
    it.each([
      ["a minimal global group", valid],
      ["an org group", { ...valid, organizationId: ID }],
      ["a null organizationId", { ...valid, organizationId: null }],
      ["a 100-character slug", { ...valid, slug: "a".repeat(100) }],
      ["a null description", { ...valid, description: null }],
      [
        "a 500-character description",
        { ...valid, description: "d".repeat(500) },
      ],
      ["100 role ids", { ...valid, roleIds: ids(100) }],
    ])("accepts %s", (_label, body) => {
      expect(CreateGroupSchema.safeParse(body).success).toBe(true);
    });

    it.each([
      ["a missing slug", { name: "Support" }, ["slug"]],
      ["an uppercase slug", { ...valid, slug: "Support" }, ["slug"]],
      ["a slug with a space", { ...valid, slug: "a b" }, ["slug"]],
      ["an empty slug", { ...valid, slug: "" }, ["slug"]],
      ["a 101-character slug", { ...valid, slug: "a".repeat(101) }, ["slug"]],
      ["an empty name", { ...valid, name: "" }, ["name"]],
      ["a 256-character name", { ...valid, name: "n".repeat(256) }, ["name"]],
      [
        "a 501-character description",
        { ...valid, description: "d".repeat(501) },
        ["description"],
      ],
      [
        "a non-uuid organizationId",
        { ...valid, organizationId: "org" },
        ["organizationId"],
      ],
      ["101 role ids", { ...valid, roleIds: ids(101) }, ["roleIds"]],
      ["a non-uuid role id", { ...valid, roleIds: ["x"] }, ["roleIds", 0]],
    ])("rejects %s", (_label, body, path) => {
      const result = CreateGroupSchema.safeParse(body);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(path);
    });
  });

  describe("UpdateGroupSchema", () => {
    it.each([
      ["a name", { name: "New" }],
      ["a slug", { slug: "new-slug" }],
      ["a null description", { description: null }],
    ])("accepts %s", (_label, body) => {
      expect(UpdateGroupSchema.safeParse(body).success).toBe(true);
    });

    it.each([
      ["an empty body", {}],
      ["a bad slug", { slug: "Bad Slug" }],
      ["an empty name", { name: "" }],
      ["a 501-character description", { description: "d".repeat(501) }],
    ])("rejects %s", (_label, body) => {
      expect(UpdateGroupSchema.safeParse(body).success).toBe(false);
    });
  });

  describe("ListGroupsQuerySchema", () => {
    it("defaults limit to 50", () => {
      expect(ListGroupsQuerySchema.parse({}).limit).toBe(50);
    });

    it.each([
      ["organizationId global", { organizationId: "global" }],
      ["an organization id", { organizationId: ID }],
      ["definitionSource provisioned", { definitionSource: "provisioned" }],
      ["includeArchived true", { includeArchived: "true" }],
      ["limit 1", { limit: "1" }],
      ["limit 100", { limit: "100" }],
    ])("accepts %s", (_label, query) => {
      expect(ListGroupsQuerySchema.safeParse(query).success).toBe(true);
    });

    it.each([
      ["limit 0", { limit: "0" }, ["limit"]],
      ["limit 101", { limit: "101" }, ["limit"]],
      ["includeArchived yes", { includeArchived: "yes" }, ["includeArchived"]],
      [
        "an unknown definitionSource",
        { definitionSource: "x" },
        ["definitionSource"],
      ],
      [
        "a non-uuid organizationId",
        { organizationId: "org" },
        ["organizationId"],
      ],
    ])("rejects %s", (_label, query, path) => {
      const result = ListGroupsQuerySchema.safeParse(query);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(path);
    });

    it("defaults includeArchived to false and parses includeArchived=true", () => {
      expect(ListGroupsQuerySchema.parse({}).includeArchived).toBe(false);
      expect(
        ListGroupsQuerySchema.parse({ includeArchived: "true" }).includeArchived
      ).toBe(true);
    });
  });

  describe("ListMembersQuerySchema", () => {
    it.each([
      ["limit 0", { limit: "0" }],
      ["limit 101", { limit: "101" }],
    ])("rejects %s", (_label, query) => {
      expect(ListMembersQuerySchema.safeParse(query).success).toBe(false);
    });
  });

  describe("AddMembersSchema", () => {
    it("accepts 500 user ids", () => {
      expect(AddMembersSchema.safeParse({ userIds: ids(500) }).success).toBe(
        true
      );
    });

    it.each([
      ["no user ids", { userIds: [] }, ["userIds"]],
      ["501 user ids", { userIds: ids(501) }, ["userIds"]],
      ["a non-uuid user id", { userIds: ["x"] }, ["userIds", 0]],
      ["a missing userIds", {}, ["userIds"]],
    ])("rejects %s", (_label, body, path) => {
      const result = AddMembersSchema.safeParse(body);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(path);
    });
  });

  describe("SetGroupRolesSchema", () => {
    it.each([
      ["no role ids", { roleIds: [] }],
      ["100 role ids", { roleIds: ids(100) }],
    ])("accepts %s", (_label, body) => {
      expect(SetGroupRolesSchema.safeParse(body).success).toBe(true);
    });

    it.each([
      ["101 role ids", { roleIds: ids(101) }, ["roleIds"]],
      ["a non-uuid role id", { roleIds: ["x"] }, ["roleIds", 0]],
    ])("rejects %s", (_label, body, path) => {
      const result = SetGroupRolesSchema.safeParse(body);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(path);
    });
  });

  describe("unknown body keys", () => {
    it.each([
      ["CreateGroupSchema", CreateGroupSchema, valid],
      ["UpdateGroupSchema", UpdateGroupSchema, { name: "x" }],
      ["AddMembersSchema", AddMembersSchema, { userIds: ids(1) }],
      ["SetGroupRolesSchema", SetGroupRolesSchema, { roleIds: ids(1) }],
    ])("%s rejects a key it does not know", (_label, schema, body) => {
      expect(schema.safeParse(body).success).toBe(true);
      const result = schema.safeParse({ ...body, userId: "x" });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].code).toBe("unrecognized_keys");
    });
  });
});
