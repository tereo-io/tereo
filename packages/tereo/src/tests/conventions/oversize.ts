// Every file under src/tests over 800 lines must be listed here with its
// reason. The layout test fails on an unlisted file over 800, on a listed file
// over its ceiling, and on a listed file at or under 800 or missing.
import type { OversizeEntry } from "../support/pure/testLayout.js";

export const OVERSIZE: ReadonlyArray<OversizeEntry> = [
  {
    path: "routes/v1/audit/entries/entries.get.test.ts",
    ceiling: 1400,
    reason:
      "GET /v1/audit/entries main behaviour: every list filter and operator, filter[q] search, facets and cursor paging; already split from POST, with its validation, limits and permissions in aspect files",
  },
];
