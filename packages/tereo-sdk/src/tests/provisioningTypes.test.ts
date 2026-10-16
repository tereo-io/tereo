import type { ProvisioningDocument } from "../index.js";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";

const full: ProvisioningDocument = {
  $schema: "./provisioning.schema.json",
  version: "1.2.3-rc.1",
  service: {
    slug: "billing",
    name: "Billing",
    namespace: "billing",
    clientId: "billing-service",
    secretFrom: "BILLING_CLIENT_SECRET",
    access: { roles: ["file_user"], audiences: ["reports"] },
    permissions: [
      {
        name: "billing.invoices.read",
        displayName: "Read invoices",
        description: "See invoices",
        orgAssignable: true,
      },
    ],
    systemRoles: [
      {
        name: "billing_reader",
        displayName: "Billing reader",
        description: "Reads invoices",
        permissions: ["billing.invoices.read"],
      },
    ],
    buckets: [
      {
        bucketName: "billing-invoices",
        description: "PDFs",
        policy: "private",
        storageQuotaBytes: 1_000_000,
      },
    ],
    eventTypes: [
      {
        eventType: "billing.invoice.created",
        description: "Invoice created",
        readPermission: "billing.invoices.read",
      },
    ],
    webhooks: [
      {
        key: "ledger",
        url: "https://ledger.example.com/hooks",
        events: ["billing.invoice.created"],
        secretFrom: "LEDGER_HOOK_SECRET",
        organizations: ["6f1c1d62-3a4b-4c58-9d0e-1f2a3b4c5d6e"],
        description: "Ledger sync",
      },
    ],
  },
  clients: [
    {
      clientId: "billing-web",
      name: "Billing web",
      clientType: "confidential",
      secretFrom: "BILLING_WEB_SECRET",
      redirectUris: ["https://billing.example.com/callback"],
      postLogoutRedirectUris: ["https://billing.example.com/"],
      scopes: ["openid"],
      grantTypes: ["authorization_code", "refresh_token"],
      audience: ["billing"],
      consentRequired: false,
      description: "The web app",
    },
  ],
  roles: [
    {
      name: "auditor",
      displayName: "Auditor",
      description: "Reads everything",
      orgAssignable: false,
      permissions: ["billing.invoices.read"],
    },
  ],
};

describe("ProvisioningDocument", () => {
  it("accepts a document with every optional field", () => {
    expect(full.service?.slug).toBe("billing");
  });

  it("accepts the smallest documents", () => {
    const minimal: ProvisioningDocument = {
      version: "1.0.0",
      roles: [{ name: "x", displayName: "X", permissions: [] }],
    };
    expect(minimal.version).toBe("1.0.0");
  });

  it("rejects unknown keys at every level", () => {
    const docs: ProvisioningDocument[] = [
      // @ts-expect-error unknown key on the document
      { version: "1.0.0", extra: true },
      {
        version: "1.0.0",
        // @ts-expect-error unknown key on the service
        service: { slug: "a", name: "A", secretFrom: "A_SECRET", extra: 1 },
      },
      {
        version: "1.0.0",
        // @ts-expect-error unknown key on a client
        clients: [{ clientId: "a", name: "A", extra: 1 }],
      },
    ];
    expect(docs).toHaveLength(3);
  });
});

describe("provisioning schema", () => {
  const schema = JSON.parse(
    readFileSync(
      new URL("../../provisioning.schema.json", import.meta.url),
      "utf8"
    )
  );
  const validate = new Ajv2020({ strict: false }).compile(schema);

  it("matches core's schema", () => {
    expect(validate(full), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate({ version: "1.0.0" }),
      JSON.stringify(validate.errors)
    ).toBe(true);
    expect(validate({ version: "1.0.0", extra: true })).toBe(false);
    expect(
      validate({
        version: "1.0.0",
        service: { slug: "a", name: "A", secretFrom: "A", extra: 1 },
      })
    ).toBe(false);
  });
});
