import { describe, expect, it } from "vitest";
import { rewrite } from "./useInfiniteGroups";

describe("useInfiniteGroups rewrite", () => {
  it("lifts menu filters to core's query params and drops sorting", () => {
    expect(
      rewrite(
        "/v1/admin/groups?limit=25&sort=name&sortDir=asc&filter[includeArchived]=true&filter[q]=sup&filter[q_op]=contains",
        undefined
      )
    ).toBe("/v1/admin/groups?limit=25&includeArchived=true&q=sup");
  });

  it("pins the organization", () => {
    expect(rewrite("/v1/admin/groups?filter[definitionSource]=", "o1")).toBe(
      "/v1/admin/groups?organizationId=o1"
    );
  });
});
