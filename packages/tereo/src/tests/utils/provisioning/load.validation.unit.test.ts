// @module-tag unit
// @module-tag provisioning
import { describe, expect, it } from "vitest";
import {
  ProvisioningError,
  parseDocuments,
} from "../../../utils/provisioning/load.js";

const client = (extra: Record<string, unknown> = {}) => ({
  clientId: "c1",
  name: "C1",
  redirectUris: ["https://app.example.com/callback"],
  ...extra,
});

const parseClient = (extra: Record<string, unknown> = {}) =>
  parseDocuments(
    [
      {
        file: "a.json",
        text: JSON.stringify({ version: "1.0.0", clients: [client(extra)] }),
      },
    ],
    {}
  ).documents[0].clients[0];

describe("parseDocuments: a client's liveEvents", () => {
  it("defaults to false", () => {
    expect(parseClient().liveEvents).toBe(false);
  });

  it("reads true", () => {
    expect(parseClient({ liveEvents: true }).liveEvents).toBe(true);
  });

  it("refuses a non-boolean", () => {
    let problems: string[] = [];
    try {
      parseClient({ liveEvents: "yes" });
    } catch (err) {
      if (!(err instanceof ProvisioningError)) throw err;
      problems = err.problems;
    }
    expect(problems.join("\n")).toContain("liveEvents");
  });
});
