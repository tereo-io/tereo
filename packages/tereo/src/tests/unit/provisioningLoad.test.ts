import { newClientSecretValue } from "../../utils/secretRules.js";
import { hashFlowToken } from "../../utils/crypto.js";
import { writeFile, mkdtemp } from "fs/promises";
import { describe, expect, it } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import {
  ProvisioningError,
  loadProvisioning,
  parseProvisioning,
} from "../../utils/provisioning/load.js";

const SECRET_A = newClientSecretValue();
const SECRET_B = newClientSecretValue();

const baseEnv = (): NodeJS.ProcessEnv => ({
  INVENTORY_SECRET: SECRET_A,
  ORDERS_SECRET: SECRET_B,
});

const service = (extra: Record<string, unknown> = {}) => ({
  slug: "vanquished-inventory",
  name: "Inventory",
  secretFrom: "INVENTORY_SECRET",
  ...extra,
});

const file = (spec: { services?: unknown[]; clients?: unknown[] }): string =>
  JSON.stringify(spec);

const problemsOf = (
  text: string,
  env: NodeJS.ProcessEnv = baseEnv()
): string[] => {
  try {
    parseProvisioning(text, env);
  } catch (err) {
    if (err instanceof ProvisioningError) return err.problems;
    throw err;
  }
  throw new Error("expected a ProvisioningError");
};

const expectNoSecrets = (problems: string[], env: NodeJS.ProcessEnv) => {
  const text = problems.join("\n");
  for (const value of Object.values(env))
    if (value) expect(text).not.toContain(value);
};

describe("parseProvisioning", () => {
  it("parses a valid file and resolves secrets to their hashes", () => {
    const result = parseProvisioning(
      file({
        services: [
          service({
            namespace: "inventory",
            clientId: "inv-client",
            access: {
              roles: ["user_resolver"],
              audiences: ["vanquished-orders"],
            },
          }),
        ],
        clients: [
          {
            clientId: "vanquished-ui",
            name: "Vanquished UI",
            clientType: "confidential",
            secretFrom: "ORDERS_SECRET",
            redirectUris: ["https://app.example.com/callback"],
            postLogoutRedirectUris: ["https://app.example.com/"],
            scopes: ["openid"],
            grantTypes: ["authorization_code"],
            audience: ["vanquished-orders"],
            consentRequired: false,
          },
        ],
      }),
      baseEnv()
    );
    expect(result.services).toEqual([
      {
        slug: "vanquished-inventory",
        name: "Inventory",
        namespace: "inventory",
        clientId: "inv-client",
        secretEnv: "INVENTORY_SECRET",
        secretHash: hashFlowToken(SECRET_A),
        access: { roles: ["user_resolver"], audiences: ["vanquished-orders"] },
      },
    ]);
    expect(result.clients[0]).toMatchObject({
      clientId: "vanquished-ui",
      clientType: "confidential",
      secretEnv: "ORDERS_SECRET",
      secretHash: hashFlowToken(SECRET_B),
      consentRequired: false,
      audience: ["vanquished-orders"],
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_A);
  });

  it("parses YAML", () => {
    const result = parseProvisioning(
      [
        "services:",
        "  - slug: vanquished-inventory",
        "    name: Inventory",
        "    secretFrom: INVENTORY_SECRET",
      ].join("\n"),
      baseEnv()
    );
    expect(result.services).toHaveLength(1);
  });

  it("applies defaults: namespace, clientId, clientType, grantTypes, consentRequired", () => {
    const result = parseProvisioning(
      file({
        services: [service({ slug: "vanquished-inventory-service" })],
        clients: [
          {
            clientId: "ui",
            name: "UI",
            redirectUris: ["https://app.example.com/callback"],
          },
        ],
      }),
      baseEnv()
    );
    expect(result.services[0]).toMatchObject({
      namespace: "vanquished-inventory",
      clientId: "vanquished-inventory-service",
      access: { roles: [], audiences: [] },
    });
    expect(result.clients[0]).toEqual({
      clientId: "ui",
      name: "UI",
      clientType: "public",
      secretEnv: null,
      secretHash: null,
      redirectUris: ["https://app.example.com/callback"],
      postLogoutRedirectUris: [],
      scopes: [],
      grantTypes: ["authorization_code", "refresh_token"],
      audience: [],
      consentRequired: true,
    });
  });

  it("accepts an empty file", () => {
    expect(parseProvisioning("", baseEnv())).toEqual({
      services: [],
      clients: [],
    });
  });

  it("reports a missing secret env var", () => {
    const env = baseEnv();
    delete env.INVENTORY_SECRET;
    const problems = problemsOf(file({ services: [service()] }), env);
    expect(problems).toEqual([
      "services[vanquished-inventory]: INVENTORY_SECRET is not set",
    ]);
  });

  it("reports a secret failing the format or strength rules", () => {
    const weak = "tereo_sk_" + "ab".repeat(21) + "c";
    for (const value of ["hunter2", weak]) {
      const env = { ...baseEnv(), INVENTORY_SECRET: value };
      const problems = problemsOf(file({ services: [service()] }), env);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(
        /^services\[vanquished-inventory\]: INVENTORY_SECRET /
      );
      expectNoSecrets(problems, env);
    }
  });

  it("reports the same secret used by two entries", () => {
    const env = { ...baseEnv(), ORDERS_SECRET: SECRET_A };
    const problems = problemsOf(
      file({
        services: [
          service(),
          service({ slug: "vanquished-orders", secretFrom: "ORDERS_SECRET" }),
        ],
      }),
      env
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("services[vanquished-inventory]");
    expect(problems[0]).toContain("services[vanquished-orders]");
    expectNoSecrets(problems, env);
  });

  it("reports a secret equal to any other env var of core", () => {
    const env = { ...baseEnv(), SETUP_TOKEN: SECRET_A };
    const problems = problemsOf(file({ services: [service()] }), env);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("SETUP_TOKEN");
    expect(problems[0]).toContain("INVENTORY_SECRET");
    expectNoSecrets(problems, env);
  });

  it("reports duplicate slugs, namespaces or clientIds within the file", () => {
    const problems = problemsOf(
      file({
        services: [
          service({ namespace: "shared", clientId: "same" }),
          service({
            name: "Dup",
            namespace: "shared",
            clientId: "same",
            secretFrom: "ORDERS_SECRET",
          }),
        ],
        clients: [{ clientId: "same", name: "UI" }],
      }),
      baseEnv()
    );
    const text = problems.join("\n");
    expect(text).toMatch(/slug "vanquished-inventory"/);
    expect(text).toMatch(/namespace "shared"/);
    expect(text).toMatch(/clientId "same"/);
  });

  it("reports a non-requestable core role in access.roles", () => {
    const problems = problemsOf(
      file({ services: [service({ access: { roles: ["admin"] } })] }),
      baseEnv()
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("services[vanquished-inventory]");
    expect(problems[0]).toContain('"admin"');
  });

  it("reports an audience naming core or the service itself", () => {
    const problems = problemsOf(
      file({
        services: [
          service({
            access: { audiences: ["core", "vanquished-inventory"] },
          }),
        ],
        clients: [{ clientId: "ui", name: "UI", audience: ["core"] }],
      }),
      baseEnv()
    );
    expect(problems).toHaveLength(3);
  });

  it("reports a confidential client without secretFrom and a public one with it", () => {
    const problems = problemsOf(
      file({
        clients: [
          { clientId: "a", name: "A", clientType: "confidential" },
          {
            clientId: "b",
            name: "B",
            clientType: "public",
            secretFrom: "ORDERS_SECRET",
          },
        ],
      }),
      baseEnv()
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("clients[a]");
    expect(problems[1]).toContain("clients[b]");
  });

  it("reports unsafe redirect URIs", () => {
    const problems = problemsOf(
      file({
        clients: [
          {
            clientId: "ui",
            name: "UI",
            redirectUris: ["javascript:alert(1)", "https://ok.example.com/cb"],
            postLogoutRedirectUris: ["not a url"],
          },
        ],
      }),
      baseEnv()
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("clients[ui]");
    expect(problems[0]).toContain("redirectUris");
    expect(problems[1]).toContain("postLogoutRedirectUris");
  });

  it("reports unknown keys and wrong types without echoing values", () => {
    const problems = problemsOf(
      file({
        services: [service({ secretfrom: "x", name: 7 })],
        clients: [{ clientId: "ui", name: "UI", clientType: "wat" }],
      })
    );
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.join("\n")).not.toContain("wat");
  });

  it("reports every problem at once", () => {
    const env = baseEnv();
    delete env.INVENTORY_SECRET;
    const problems = problemsOf(
      file({ services: [service({ access: { roles: ["admin"] } })] }),
      env
    );
    expect(problems).toHaveLength(2);
  });

  it("never includes the secret in problems", () => {
    const leaky = "tereo_sk_LEAKME" + "!".repeat(5);
    const env = { ...baseEnv(), INVENTORY_SECRET: leaky };
    const problems = problemsOf(
      file({ services: [service({ secretFrom: leaky })] }),
      env
    );
    expect(problems.length).toBeGreaterThan(0);
    expectNoSecrets(problems, env);
    expect(problems.join("\n")).not.toContain(leaky);
  });
});

describe("loadProvisioning", () => {
  it("returns null when PROVISIONING_FILE is unset", async () => {
    expect(await loadProvisioning(undefined)).toBeNull();
  });

  it("reads and parses the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prov-"));
    const path = join(dir, "p.yaml");
    await writeFile(path, "services: []\nclients: []\n");
    expect(await loadProvisioning(path, baseEnv())).toEqual({
      services: [],
      clients: [],
    });
  });

  it("reports an unreadable file", async () => {
    await expect(
      loadProvisioning("/nonexistent/provisioning.yaml", baseEnv())
    ).rejects.toMatchObject({
      problems: [expect.stringContaining("/nonexistent/provisioning.yaml")],
    });
  });

  it("reports invalid YAML", () => {
    const problems = problemsOf("services: [unterminated");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/not valid YAML/);
  });

  it("reports a file that is not a mapping", () => {
    expect(problemsOf("- a\n- b\n")).toHaveLength(1);
  });
});
