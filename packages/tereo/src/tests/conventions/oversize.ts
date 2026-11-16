// Every file under src/tests over 800 lines must be listed here with its
// reason. The layout test fails on an unlisted file over 800, on a listed file
// over its ceiling, and on a listed file at or under 800 or missing.
import type { OversizeEntry } from "../support/pure/testLayout.js";

export const OVERSIZE: ReadonlyArray<OversizeEntry> = [
  {
    path: "routes/v1/audit/entries/entries.get.test.ts",
    ceiling: 1350,
    reason:
      "GET /v1/audit/entries main behaviour: every list filter and operator, filter[q] search, facets and cursor paging; already split from POST, with its validation, limits and permissions in aspect files",
  },
  {
    path: "routes/v1/admin/clients/client/client.test.ts",
    ceiling: 850,
    reason:
      "GET, PATCH, regenerate-secret and DELETE on one admin client, plus the service-client variants; audit, permissions and validation already live in aspect files",
  },
  {
    path: "utils/provisioning/apply.test.ts",
    ceiling: 1630,
    reason:
      "applyProvisioning main behaviour, one section per item kind it applies (services, login clients, custom roles, webhooks, integrations, declarations, guest roles and default roles, retirement and the 409 managed_by_provisioning edits); function module with no methods to split on, and its errors, permissions, audit and races already live in aspect files",
  },
  {
    path: "utils/provisioning/load.unit.test.ts",
    ceiling: 830,
    reason:
      "parseDocuments and loadProvisioningSet main behaviour, one section per document field; its validation already lives in aspect files",
  },
];
