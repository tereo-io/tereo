import { newClientSecretValue } from "../../utils/secretRules.js";
import { mkdir, mkdtemp, symlink, writeFile } from "fs/promises";
import { hashFlowToken } from "../../utils/crypto.js";
import { describe, expect, it } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import {
  ProvisioningError,
  loadProvisioningSet,
  parseDocuments,
} from "../../utils/provisioning/load.js";

const SECRET_A = newClientSecretValue();
const SECRET_B = newClientSecretValue();
const SECRET_C = newClientSecretValue();

const baseEnv = (): NodeJS.ProcessEnv => ({
  INVENTORY_SECRET: SECRET_A,
  ORDERS_SECRET: SECRET_B,
  HOOK_SECRET: SECRET_C,
});

const service = (extra: Record<string, unknown> = {}) => ({
  slug: "vanquished-inventory",
  name: "Inventory",
  secretFrom: "INVENTORY_SECRET",
  ...extra,
});

const webhook = (extra: Record<string, unknown> = {}) => ({
  key: "stock",
  url: "https://inventory.example.com/hooks",
  events: ["inventory.stock.changed"],
  secretFrom: "HOOK_SECRET",
  ...extra,
});

const doc = (body: Record<string, unknown>) =>
  JSON.stringify({ version: "1.0.0", ...body });

const parse = (
  docs: Record<string, string>,
  env: NodeJS.ProcessEnv = baseEnv()
) =>
  parseDocuments(
    Object.entries(docs).map(([file, text]) => ({ file, text })),
    env
  );

const problemsOf = (
  docs: Record<string, string>,
  env: NodeJS.ProcessEnv = baseEnv()
): string[] => {
  try {
    parse(docs, env);
  } catch (err) {
    if (err instanceof ProvisioningError) return err.problems;
    throw err;
  }
  throw new Error("expected a ProvisioningError");
};

const problemsOfPath = async (path: string): Promise<string[]> => {
  try {
    await loadProvisioningSet(path, baseEnv());
  } catch (err) {
    if (err instanceof ProvisioningError) return err.problems;
    throw err;
  }
  throw new Error("expected a ProvisioningError");
};

const tempDir = () => mkdtemp(join(tmpdir(), "provisioning-docs-"));
const roleDoc = doc({
  roles: [{ name: "viewer", displayName: "Viewer", permissions: [] }],
});

describe("reading a provisioning path", () => {
  it("reads every *.json in a directory in name order", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "b.json"), roleDoc);
    await writeFile(join(dir, "a.json"), roleDoc);
    await writeFile(join(dir, "notes.txt"), "not a document");
    await writeFile(join(dir, ".hidden.json"), "{ not read");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "c.json"), roleDoc);
    const set = await loadProvisioningSet(dir, baseEnv());
    expect(set?.documents.map((d) => d.file)).toEqual(["a.json", "b.json"]);
  });

  it("reads through a ConfigMap-style mount", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "..2026_10_16"));
    await writeFile(join(dir, "..2026_10_16", "a.json"), roleDoc);
    await symlink("..2026_10_16", join(dir, "..data"));
    await symlink(join("..data", "a.json"), join(dir, "a.json"));
    const set = await loadProvisioningSet(dir, baseEnv());
    expect(set?.documents.map((d) => d.file)).toEqual(["a.json"]);
  });

  it("reads a single file", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "one.json"), roleDoc);
    const set = await loadProvisioningSet(join(dir, "one.json"), baseEnv());
    expect(set?.documents.map((d) => d.file)).toEqual(["one.json"]);
  });

  it("refuses a directory with no documents", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "notes.txt"), "x");
    expect(await problemsOfPath(dir)).toEqual([
      `no provisioning documents in ${dir}`,
    ]);
  });

  it("refuses a path that cannot be read", async () => {
    const problems = await problemsOfPath(join(await tempDir(), "missing"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("cannot read PROVISIONING_PATH");
  });

  it("returns null when PROVISIONING_PATH is unset", async () => {
    expect(await loadProvisioningSet(undefined, baseEnv())).toBeNull();
  });
});

describe("parseDocuments", () => {
  it("reports JSON syntax errors with the file name", () => {
    const problems = problemsOf({ "bad.json": '{"version": "1.0.0",}' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^bad\.json: not valid JSON/);
  });

  it("refuses a document with no section", () => {
    const problems = problemsOf({ "a.json": doc({}) });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^a\.json: /);
    expect(problems[0]).toContain("needs one of service, clients, roles");
  });

  it("refuses a non-semver version", () => {
    const problems = problemsOf({
      "a.json": JSON.stringify({ version: "1.10", roles: [] }),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("version");
  });

  it("refuses unknown keys at every level", () => {
    const problems = problemsOf({
      "a.json": doc({
        topKey: "SECRETVALUE1",
        service: service({
          serviceKey: "SECRETVALUE2",
          webhooks: [webhook({ hookKey: "SECRETVALUE3" })],
        }),
        roles: [
          {
            name: "viewer",
            displayName: "Viewer",
            permissions: [],
            roleKey: "SECRETVALUE4",
          },
        ],
      }),
    });
    expect(problems).toHaveLength(4);
    for (const key of ["topKey", "serviceKey", "hookKey", "roleKey"])
      expect(problems.filter((p) => p.includes(`"${key}"`))).toHaveLength(1);
    expect(problems.join("\n")).not.toContain("SECRETVALUE");
  });

  it("applies service defaults", () => {
    const set = parse({
      "a.json": doc({ service: service({ webhooks: [webhook()] }) }),
    });
    const s = set.documents[0].service!;
    expect(s.namespace).toBe("vanquished-inventory".replace(/-service$/, ""));
    expect(s.clientId).toBe("vanquished-inventory");
    expect(s.webhooks[0].organizations).toBe("all");
    const bare = parse({ "b.json": doc({ service: service() }) });
    expect(bare.documents[0].service!.webhooks).toEqual([]);
  });

  it("resolves service, client and webhook secrets", () => {
    const set = parse({
      "a.json": doc({
        service: service({ webhooks: [webhook()] }),
        clients: [
          {
            clientId: "orders-ui",
            name: "Orders",
            clientType: "confidential",
            secretFrom: "ORDERS_SECRET",
            redirectUris: ["https://orders.example.com/callback"],
            description: "Orders UI",
          },
        ],
      }),
    });
    const [d] = set.documents;
    expect(d.version).toBe("1.0.0");
    expect(d.service!.secretEnv).toBe("INVENTORY_SECRET");
    expect(d.service!.secretHash).toBe(hashFlowToken(SECRET_A));
    expect(d.service!.webhooks[0].secretEnv).toBe("HOOK_SECRET");
    expect(d.service!.webhooks[0].secretPlain).toBe(SECRET_C);
    expect(d.clients[0].secretHash).toBe(hashFlowToken(SECRET_B));
    expect(d.clients[0].description).toBe("Orders UI");
  });

  it("lets webhooks of one service share a secret", () => {
    expect(() =>
      parse({
        "a.json": doc({
          service: service({
            webhooks: [webhook(), webhook({ key: "stock-two" })],
          }),
        }),
      })
    ).not.toThrow();
  });

  it("refuses a secret shared across services, or between a service and a webhook", () => {
    const across = problemsOf(
      {
        "a.json": doc({ service: service() }),
        "b.json": doc({
          service: service({ slug: "vanquished-orders", name: "Orders" }),
        }),
      },
      baseEnv()
    );
    expect(across.join("\n")).toContain("used by more than one entry");

    const within = problemsOf({
      "a.json": doc({
        service: service({
          webhooks: [webhook({ secretFrom: "INVENTORY_SECRET" })],
        }),
      }),
    });
    expect(within.join("\n")).toContain("used by more than one entry");
  });

  it("applies the per-client rules", () => {
    const problems = problemsOf({
      "a.json": doc({
        clients: [
          { clientId: "c1", name: "C1", clientType: "confidential" },
          { clientId: "c2", name: "C2", redirectUris: ["javascript:alert(1)"] },
          { clientId: "c3", name: "C3" },
        ],
      }),
    });
    const text = problems.join("\n");
    expect(text).toContain("a confidential client needs secretFrom");
    expect(text).toContain("redirectUris[0] is not a safe URL");
    expect(text).toContain("needs at least one redirect URI");
  });

  it("never includes a secret in problems", () => {
    const env = { ...baseEnv(), INVENTORY_SECRET: "short" };
    const problems = problemsOf({ "a.json": doc({ service: service() }) }, env);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).not.toContain("short");
    const pasted = problemsOf({
      "a.json": doc({ service: service({ secretFrom: SECRET_A }) }),
    });
    expect(pasted.join("\n")).not.toContain(SECRET_A);
  });
});
