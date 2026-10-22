// @module-tag int
// @module-tag provisioning
import { parseDocuments } from "../../../utils/provisioning/load.js";
import { ensureTestOrganization } from "../../support/principals.js";
import { generateClientSecret } from "../../../utils/crypto.js";
import { describe, it, expect, beforeAll } from "vitest";

let orgId: string;

const newSecret = () => {
  const { plainSecret, hashedSecret } = generateClientSecret();
  return { plain: plainSecret, hash: hashedSecret };
};

beforeAll(async () => {
  orgId = await ensureTestOrganization("integrations-prov-org");
});

describe("parseDocuments", () => {
  describe("integrations in documents", () => {
    it("parses an integrations section, enough on its own", () => {
      const secret = newSecret();
      const set = parseDocuments(
        [
          {
            file: "integrations.json",
            text: JSON.stringify({
              version: "1.0.0",
              integrations: [
                {
                  slug: "acme-3pl",
                  name: "Acme 3PL",
                  organizationId: orgId,
                  secretFrom: "ACME_SECRET",
                  roles: ["shipper"],
                },
              ],
            }),
          },
        ],
        { ACME_SECRET: secret.plain }
      );
      expect(set.documents[0].integrations).toEqual([
        {
          slug: "acme-3pl",
          name: "Acme 3PL",
          organizationId: orgId,
          clientId: "acme-3pl",
          secretEnv: "ACME_SECRET",
          secretHash: secret.hash,
          roles: ["shipper"],
          audiences: [],
        },
      ]);
    });

    it("requires the integration's secret", () => {
      expect(() =>
        parseDocuments(
          [
            {
              file: "integrations.json",
              text: JSON.stringify({
                version: "1.0.0",
                integrations: [
                  { slug: "acme-3pl", name: "Acme", secretFrom: "MISSING_X" },
                ],
              }),
            },
          ],
          {}
        )
      ).toThrow(/integrations\[acme-3pl\]: MISSING_X is not set/);
    });
  });
});
