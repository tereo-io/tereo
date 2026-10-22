// @module-tag unit
// @module-tag auth
import { CreateClientSchema } from "../../../../../routes/v1/admin/clients/schemas.js";
import { describe, expect, it } from "vitest";

describe("POST /v1/admin/clients", () => {
  describe("CreateClientSchema", () => {
    it.each([
      [
        "a public client without redirectUris",
        {
          name: "Test Client",
          clientType: "public",
          grantTypes: ["authorization_code"],
        },
        ["redirectUris"],
      ],
      [
        "an empty grantTypes",
        { name: "No Grants", clientType: "confidential", grantTypes: [] },
        ["grantTypes"],
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
        ["grantTypes", 0],
      ],
    ])("rejects %s", (_label, body, path) => {
      const result = CreateClientSchema.safeParse(body);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(path);
    });
  });
});
