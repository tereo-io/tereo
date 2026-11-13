// @module-tag unit
// @module-tag auth
import { ScimPatchBodySchema } from "../../../utils/scim/patch.js";
import { describe, expect, it } from "vitest";
import {
  normaliseGroupPatch,
  resolveGroupOps,
} from "../../../utils/scim/groupPatch.js";
import {
  entraAddMembersPatch,
  entraRemoveMembersPatch,
  entraRenameGroupPatch,
} from "../../fixtures/scim/entra.js";
import {
  oktaAddMembersPatch,
  oktaRemoveMemberPatch,
  oktaRenameGroupPatch,
} from "../../fixtures/scim/okta.js";

const patch = (...Operations: Array<Record<string, unknown>>) =>
  normaliseGroupPatch(ScimPatchBodySchema.parse({ Operations }));

const members = (...ids: string[]) => ids.map((value) => ({ value }));
const code = (c: string) => expect.objectContaining({ code: c });

describe("normaliseGroupPatch", () => {
  it("add members", () => {
    expect(
      patch({ op: "add", path: "members", value: members("u1", "u2") })
    ).toEqual([{ kind: "addMembers", values: ["u1", "u2"] }]);
  });

  it("remove members with a value list", () => {
    expect(
      patch({ op: "remove", path: "members", value: members("u1") })
    ).toEqual([{ kind: "removeMembers", values: ["u1"] }]);
  });

  it("remove members without a value clears the group", () => {
    expect(patch({ op: "remove", path: "members" })).toEqual([
      { kind: "clearMembers" },
    ]);
  });

  it("remove members with a value selector", () => {
    expect(patch({ op: "remove", path: 'members[value eq "u1"]' })).toEqual([
      { kind: "removeMembers", values: ["u1"] },
    ]);
  });

  it("replace members", () => {
    expect(
      patch({ op: "replace", path: "members", value: members("u1") })
    ).toEqual([{ kind: "replaceMembers", values: ["u1"] }]);
  });

  it("replace displayName and externalId", () => {
    expect(
      patch(
        { op: "replace", path: "displayName", value: "  New  " },
        { op: "replace", path: "externalId", value: "x1" }
      )
    ).toEqual([
      { kind: "displayName", value: "New" },
      { kind: "externalId", value: "x1" },
    ]);
  });

  it("a blank externalId clears it", () => {
    expect(patch({ op: "replace", path: "externalId", value: " " })).toEqual([
      { kind: "externalId", value: null },
    ]);
  });

  it("remove externalId clears it", () => {
    expect(patch({ op: "remove", path: "externalId" })).toEqual([
      { kind: "externalId", value: null },
    ]);
  });

  it("remove displayName is invalidValue", () => {
    expect(() => patch({ op: "remove", path: "displayName" })).toThrow(
      code("invalidValue")
    );
  });

  it.each([[""], ["   "], [7], [null], ["a".repeat(256)]])(
    "rejects displayName %j",
    (value) => {
      expect(() =>
        patch({ op: "replace", path: "displayName", value })
      ).toThrow(code("invalidValue"));
    }
  );

  it("a no-path add object appends members", () => {
    expect(
      patch({
        op: "add",
        value: { displayName: "N", externalId: "e", members: members("u1") },
      })
    ).toEqual([
      { kind: "displayName", value: "N" },
      { kind: "externalId", value: "e" },
      { kind: "addMembers", values: ["u1"] },
    ]);
  });

  it("a no-path replace object carries displayName and members", () => {
    expect(
      patch({
        op: "replace",
        value: { displayName: "N", members: members("u1"), other: 1 },
      })
    ).toEqual([
      { kind: "displayName", value: "N" },
      { kind: "replaceMembers", values: ["u1"] },
    ]);
  });

  it("no-path remove is invalidPath", () => {
    expect(() => patch({ op: "remove" })).toThrow(code("invalidPath"));
  });

  it("a no-path non-object value is invalidValue", () => {
    expect(() => patch({ op: "add", value: "x" })).toThrow(
      code("invalidValue")
    );
  });

  it("is case-insensitive in op and path", () => {
    expect(
      patch(
        { op: "Add", path: "Members", value: members("u1") },
        { op: "REMOVE", path: "MEMBERS", value: members("u2") },
        { op: "Replace", path: "DisplayName", value: "D" }
      )
    ).toEqual([
      { kind: "addMembers", values: ["u1"] },
      { kind: "removeMembers", values: ["u2"] },
      { kind: "displayName", value: "D" },
    ]);
  });

  it("strips a schema prefix from the path", () => {
    expect(
      patch({
        op: "replace",
        path: "urn:ietf:params:scim:schemas:core:2.0:Group:displayName",
        value: "D",
      })
    ).toEqual([{ kind: "displayName", value: "D" }]);
  });

  it("selector paths are accepted only with remove", () => {
    expect(() =>
      patch({ op: "add", path: 'members[value eq "u1"]', value: members("u1") })
    ).toThrow(code("invalidPath"));
    expect(() =>
      patch({ op: "replace", path: 'members[value eq "u1"]' })
    ).toThrow(code("invalidPath"));
  });

  it("an unknown path is invalidPath", () => {
    expect(() => patch({ op: "replace", path: "active", value: true })).toThrow(
      code("invalidPath")
    );
    expect(() => patch({ op: "remove", path: "members.value" })).toThrow(
      code("invalidPath")
    );
  });

  it("an unsupported op is invalidSyntax", () => {
    expect(() => patch({ op: "move", path: "members" })).toThrow(
      code("invalidSyntax")
    );
  });

  it("a non-string member value is invalidValue", () => {
    expect(() =>
      patch({ op: "add", path: "members", value: [{ value: 5 }] })
    ).toThrow(code("invalidValue"));
  });

  it("members given as a non-array is invalidValue", () => {
    expect(() => patch({ op: "add", path: "members", value: "u1" })).toThrow(
      code("invalidValue")
    );
  });

  it("deduplicates member values", () => {
    expect(
      patch({ op: "add", path: "members", value: members("u1", "u1") })
    ).toEqual([{ kind: "addMembers", values: ["u1"] }]);
  });

  it("allows exactly 5000 values and rejects 5001 with tooMany", () => {
    const ids = (n: number) =>
      members(...Array.from({ length: n }, (_, i) => `u${i}`));
    expect(
      patch({ op: "add", path: "members", value: ids(5000) })
    ).toHaveLength(1);
    expect(() =>
      patch({ op: "add", path: "members", value: ids(5001) })
    ).toThrow(code("tooMany"));
  });

  it("keeps the order of operations", () => {
    expect(
      patch(
        { op: "remove", path: "members" },
        { op: "add", path: "members", value: members("u1") }
      )
    ).toEqual([
      { kind: "clearMembers" },
      { kind: "addMembers", values: ["u1"] },
    ]);
  });

  describe("vendor fixtures", () => {
    const run = (fixture: unknown) =>
      normaliseGroupPatch(ScimPatchBodySchema.parse(fixture));

    it("Okta add, remove and rename", () => {
      expect(run(oktaAddMembersPatch)).toEqual([
        {
          kind: "addMembers",
          values: ["0198f2a4-0000-7000-8000-000000000003"],
        },
      ]);
      expect(run(oktaRemoveMemberPatch)).toEqual([
        {
          kind: "removeMembers",
          values: ["0198f2a4-0000-7000-8000-000000000002"],
        },
      ]);
      expect(run(oktaRenameGroupPatch)).toEqual([
        { kind: "displayName", value: "Platform Eng" },
      ]);
    });

    it("Entra add, remove and rename", () => {
      expect(run(entraAddMembersPatch)).toEqual([
        {
          kind: "addMembers",
          values: ["0198f2a4-0000-7000-8000-000000000003"],
        },
      ]);
      expect(run(entraRemoveMembersPatch)).toEqual([
        {
          kind: "removeMembers",
          values: [
            "0198f2a4-0000-7000-8000-000000000001",
            "0198f2a4-0000-7000-8000-000000000002",
          ],
        },
      ]);
      expect(run(entraRenameGroupPatch)).toEqual([
        { kind: "displayName", value: "Platform Eng" },
      ]);
    });
  });
});

describe("resolveGroupOps", () => {
  const A = "0198f2a4-0000-7000-8000-00000000000a";
  const B = "0198f2a4-0000-7000-8000-00000000000b";
  const C = "0198f2a4-0000-7000-8000-00000000000c";
  const ids = (plan: { desired: Set<string> }) => [...plan.desired].sort();

  it("applies operations in order", () => {
    expect(
      ids(
        resolveGroupOps(
          [
            { kind: "addMembers", values: [A] },
            { kind: "removeMembers", values: [A] },
          ],
          [B],
          []
        )
      )
    ).toEqual([B]);
    expect(
      ids(
        resolveGroupOps(
          [
            { kind: "removeMembers", values: [B] },
            { kind: "addMembers", values: [B] },
          ],
          [B],
          []
        )
      )
    ).toEqual([B]);
  });

  it("clears and replaces, ignoring values that are not uuids", () => {
    expect(
      ids(resolveGroupOps([{ kind: "clearMembers" }], [A, B], [C]))
    ).toEqual([]);
    expect(
      ids(
        resolveGroupOps(
          [{ kind: "replaceMembers", values: [C, "nope", C.toUpperCase()] }],
          [A],
          []
        )
      )
    ).toEqual([C]);
  });

  it("retries recorded skips only when the request touches members", () => {
    expect(
      ids(resolveGroupOps([{ kind: "addMembers", values: [A] }], [], [B]))
    ).toEqual([A, B]);
    const rename = resolveGroupOps(
      [{ kind: "displayName", value: "X" }],
      [A],
      [B]
    );
    expect(ids(rename)).toEqual([A]);
    expect(rename).toMatchObject({ touchesMembers: false, displayName: "X" });
  });

  it("a removal drops a recorded skip, and the last name wins", () => {
    const plan = resolveGroupOps(
      [
        { kind: "removeMembers", values: [B] },
        { kind: "externalId", value: "one" },
        { kind: "externalId", value: null },
      ],
      [],
      [B]
    );
    expect(ids(plan)).toEqual([]);
    expect(plan.externalId).toBeNull();
  });
});
