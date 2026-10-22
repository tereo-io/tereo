// @module-tag unit
// @module-tag files
import { describe, expect, it } from "vitest";
import {
  parseRewrapArgs,
  RewrapUsageError,
} from "../../../cli/rewrapMasterKey/index.js";

describe("parseRewrapArgs", () => {
  describe("argument parsing", () => {
    it("parses every option", () => {
      const upload = "0190f0e0-0000-7000-8000-000000000001";
      expect(
        parseRewrapArgs([
          "--dry-run",
          "--from-hash",
          "ab12",
          "--from-upload",
          upload,
          "--limit",
          "5",
          "--page-size",
          "50",
        ])
      ).toEqual({
        dryRun: true,
        fromHash: "ab12",
        fromUpload: upload,
        limit: 5,
        pageSize: 50,
      });
    });

    it.each([
      [["--limit", "abc"]],
      [["--limit", "0"]],
      [["--limit", "-1"]],
      [["--limit", "1.5"]],
      [["--page-size", "0"]],
      [["--page-size"]],
      [["--from-hash"]],
      [["--from-hash", "--dry-run"]],
      [["--from-hash", "not-hex"]],
      [["--from-upload", "nope"]],
      [["--dryrun"]],
      [["extra"]],
    ])("refuses %j", (argv) => {
      expect(() => parseRewrapArgs(argv)).toThrow(RewrapUsageError);
    });
  });
});
