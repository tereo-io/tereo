// @module-tag unit
// @module-tag auth
import { CreateClientSchema } from "../../../../../routes/v1/admin/clients/schemas.js";
import { describe, expect, it } from "vitest";

describe("POST /v1/admin/clients", () => {
  describe("CreateClientSchema", () => {
    it.each([
      [
        "a public client without redirectUris",
        { name: "Test Client", clientType: "public" },
      ],
      [
        "an empty grantTypes",
        { name: "No Grants", clientType: "confidential", grantTypes: [] },
      ],
      [
        "the client_credentials grant: a machine identity is added as a service",
        {
          name: "Machine",
          clientType: "confidential",
          redirectUris: [],
          scopes: ["openid"],
          grantTypes: ["client_credentials"],
        },
      ],
    ])("rejects %s", (_label, body) => {
      expect(CreateClientSchema.safeParse(body).success).toBe(false);
    });
  });
});
