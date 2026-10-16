import { validateSet } from "../../utils/provisioning/validate.js";
import { describe, expect, it } from "vitest";
import type {
  LoadedDocument,
  ResolvedClient,
  ResolvedService,
  ResolvedWebhook,
} from "../../utils/provisioning/load.js";

type ServiceInput = Partial<Omit<ResolvedService, "webhooks">> & {
  slug: string;
  webhooks?: Partial<ResolvedWebhook>[];
};

const serviceOf = (s: ServiceInput): ResolvedService => {
  const namespace = s.namespace ?? s.slug.replace(/-service$/, "");
  return {
    name: s.slug,
    namespace,
    clientId: s.clientId ?? s.slug,
    secretEnv: `${namespace.toUpperCase()}_SECRET`,
    secretHash: "hash",
    access: { roles: [], audiences: [] },
    permissions: [],
    systemRoles: [],
    buckets: [],
    eventTypes: [],
    ...s,
    webhooks: (s.webhooks ?? []).map((w) => ({
      key: "hook",
      url: "https://hooks.example.com/in",
      events: [],
      organizations: "all",
      description: null,
      secretEnv: "HOOK_SECRET",
      secretPlain: "plain",
      ...w,
    })),
  };
};

const clientOf = (
  c: Partial<ResolvedClient> & { clientId: string }
): ResolvedClient => ({
  name: c.clientId,
  description: null,
  clientType: "public",
  secretEnv: null,
  secretHash: null,
  redirectUris: ["https://app.example.com/callback"],
  postLogoutRedirectUris: [],
  scopes: [],
  grantTypes: ["authorization_code", "refresh_token"],
  audience: [],
  consentRequired: true,
  ...c,
});

const doc = (
  file: string,
  body: {
    version?: string;
    service?: ServiceInput;
    clients?: (Partial<ResolvedClient> & { clientId: string })[];
    roles?: LoadedDocument["roles"];
  }
): LoadedDocument => ({
  file,
  version: body.version ?? "1.0.0",
  service: body.service ? serviceOf(body.service) : null,
  clients: (body.clients ?? []).map(clientOf),
  roles: body.roles ?? [],
});

const validate = (...documents: LoadedDocument[]) => validateSet({ documents });

const perm = (name: string, orgAssignable = false) => ({
  name,
  displayName: name,
  description: "",
  orgAssignable,
});

const alpha = (extra: Partial<ServiceInput> = {}): ServiceInput => ({
  slug: "alpha-service",
  permissions: [perm("alpha.items.read"), perm("alpha.items.write")],
  systemRoles: [
    {
      name: "alpha_reader",
      displayName: "Alpha reader",
      description: "",
      permissions: ["alpha.items.read"],
    },
  ],
  eventTypes: [
    {
      eventType: "alpha.item.created",
      description: "",
      readPermission: "alpha.items.read",
    },
  ],
  ...extra,
});

const beta = (extra: Partial<ServiceInput> = {}): ServiceInput => ({
  slug: "beta-service",
  permissions: [perm("beta.items.read", true)],
  systemRoles: [
    {
      name: "beta_reader",
      displayName: "Beta reader",
      description: "",
      permissions: ["beta.items.read"],
    },
  ],
  eventTypes: [
    {
      eventType: "beta.item.created",
      description: "",
      readPermission: "beta.items.read",
    },
  ],
  ...extra,
});

const customRole = (
  extra: Partial<LoadedDocument["roles"][number]> = {}
): LoadedDocument["roles"][number] => ({
  name: "support",
  displayName: "Support",
  orgAssignable: false,
  permissions: [],
  ...extra,
});

describe("validateSet", () => {
  it("accepts a mutual pair granting each other roles", () => {
    expect(
      validate(
        doc("a.json", {
          service: alpha({
            access: { roles: ["beta-service/beta_reader"], audiences: [] },
          }),
        }),
        doc("b.json", {
          service: beta({
            access: { roles: ["alpha-service/alpha_reader"], audiences: [] },
          }),
        })
      )
    ).toEqual([]);
  });

  it("refuses a role naming no service in the set", () => {
    expect(
      validate(
        doc("a.json", {
          service: alpha({
            access: { roles: ["ghost-service/x"], audiences: [] },
          }),
        })
      )
    ).toEqual([
      'a.json: services[alpha-service]: access.roles "ghost-service/x" is not a system role declared in the provisioning set',
    ]);
  });

  it("refuses a role a service in the set does not declare", () => {
    const problems = validate(
      doc("a.json", {
        service: alpha({
          access: { roles: ["beta-service/beta_writer"], audiences: [] },
        }),
      }),
      doc("b.json", { service: beta() })
    );
    expect(problems).toEqual([
      'a.json: services[alpha-service]: access.roles "beta-service/beta_writer" is not a system role declared in the provisioning set',
    ]);
  });

  it("refuses its own role, core/ spellings and non-requestable core roles", () => {
    const problems = validate(
      doc("a.json", {
        service: alpha({
          access: {
            roles: ["alpha-service/alpha_reader", "core/file_user", "admin"],
            audiences: [],
          },
        }),
      })
    );
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('"alpha-service/alpha_reader"');
    expect(problems[1]).toContain('"core/file_user"');
    expect(problems[2]).toContain('"admin"');
    for (const p of problems)
      expect(p.startsWith("a.json: services[alpha-service]: ")).toBe(true);
  });

  it("accepts requestable core roles", () => {
    expect(
      validate(
        doc("a.json", {
          service: alpha({
            access: { roles: ["file_user", "tenant_resolver"], audiences: [] },
          }),
        })
      )
    ).toEqual([]);
  });

  it("refuses an audience naming no service in the set", () => {
    const problems = validate(
      doc("a.json", {
        service: alpha({
          access: { roles: [], audiences: ["ghost-service"] },
        }),
        clients: [{ clientId: "web", audience: ["ghost-service"] }],
      })
    );
    expect(problems).toEqual([
      'a.json: services[alpha-service]: access.audiences "ghost-service" is not a service in the provisioning set',
      'a.json: clients[web]: audience "ghost-service" is not a service in the provisioning set',
    ]);
  });

  it("accepts audiences naming services in the set, and refuses its own", () => {
    expect(
      validate(
        doc("a.json", {
          service: alpha({
            access: { roles: [], audiences: ["beta-service"] },
          }),
          clients: [{ clientId: "web", audience: ["alpha-service"] }],
        }),
        doc("b.json", { service: beta() })
      )
    ).toEqual([]);
    expect(
      validate(
        doc("a.json", {
          service: alpha({
            access: { roles: [], audiences: ["alpha-service"] },
          }),
        })
      )
    ).toHaveLength(1);
  });

  describe("reports duplicates naming both files", () => {
    const expectBoth = (problems: string[], what: string) => {
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("a.json");
      expect(problems[0]).toContain("b.json");
      expect(problems[0]).toContain(what);
    };

    it("service slug", () => {
      expectBoth(
        validate(
          doc("a.json", { service: { slug: "alpha-service" } }),
          doc("b.json", {
            service: {
              slug: "alpha-service",
              namespace: "other",
              clientId: "other",
            },
          })
        ),
        "alpha-service"
      );
    });

    it("namespace", () => {
      expectBoth(
        validate(
          doc("a.json", { service: { slug: "alpha-service" } }),
          doc("b.json", {
            service: { slug: "beta-service", namespace: "alpha" },
          })
        ),
        '"alpha"'
      );
    });

    it("clientId, a service's and a login client's", () => {
      expectBoth(
        validate(
          doc("a.json", { service: { slug: "alpha-service" } }),
          doc("b.json", { clients: [{ clientId: "alpha-service" }] })
        ),
        "alpha-service"
      );
    });

    it("custom role name", () => {
      expectBoth(
        validate(
          doc("a.json", { roles: [customRole()] }),
          doc("b.json", { roles: [customRole()] })
        ),
        "support"
      );
    });

    it("permission, event type and bucket names", () => {
      // Equal namespaces make the names collide; the namespace is reported
      // too, so only the item kinds are checked here.
      const shared: Partial<ServiceInput> = {
        namespace: "alpha",
        permissions: [perm("alpha.items.read")],
        eventTypes: [{ eventType: "alpha.item.created", description: "" }],
        buckets: [{ bucketName: "alpha-images", policy: "private" }],
      };
      const problems = validate(
        doc("a.json", { service: { slug: "alpha-service", ...shared } }),
        doc("b.json", { service: { slug: "beta-service", ...shared } })
      );
      for (const what of [
        '"alpha.items.read"',
        '"alpha.item.created"',
        '"alpha-images"',
      ]) {
        const p = problems.find((x) => x.includes(what));
        expect(p).toBeDefined();
        expect(p).toContain("a.json");
        expect(p).toContain("b.json");
      }
    });

    it("webhook key within one service", () => {
      const problems = validate(
        doc("a.json", {
          service: alpha({
            access: { roles: ["beta-service/beta_reader"], audiences: [] },
            webhooks: [
              { key: "k", events: ["beta.item.created"] },
              { key: "k", events: ["beta.item.created"] },
            ],
          }),
        }),
        doc("b.json", { service: beta() })
      );
      expect(problems).toEqual([
        'a.json: services[alpha-service]: webhook key "k" is used by more than one entry',
      ]);
    });
  });

  it("refuses a custom role permission nobody declares, and accepts core's or another document's", () => {
    expect(
      validate(
        doc("roles.json", {
          roles: [customRole({ permissions: ["nobody.things.read"] })],
        })
      )
    ).toEqual([
      'roles.json: roles[support]: permission "nobody.things.read" is declared by no service in the set nor by core',
    ]);
    expect(
      validate(
        doc("roles.json", {
          roles: [
            customRole({ permissions: ["users.read", "alpha.items.read"] }),
          ],
        }),
        doc("alpha.json", { service: alpha() })
      )
    ).toEqual([]);
  });

  it("refuses an org-assignable custom role with a global-only permission", () => {
    expect(
      validate(
        doc("roles.json", {
          roles: [
            customRole({
              orgAssignable: true,
              permissions: [
                "users.read",
                "beta.items.read",
                "file-service.objects.read",
              ],
            }),
          ],
        }),
        doc("b.json", { service: beta() })
      )
    ).toEqual([
      'roles.json: roles[support]: an org-assignable role may hold only org-assignable permissions: "users.read"',
    ]);
  });

  it("refuses a custom role named like a system role", () => {
    const problems = validate(
      doc("roles.json", {
        roles: [
          customRole({ name: "admin" }),
          customRole({ name: "alpha_reader" }),
        ],
      }),
      doc("a.json", { service: alpha() })
    );
    expect(problems).toEqual([
      'roles.json: roles[admin]: a system role of core is named "admin"',
      'roles.json and a.json: roles[alpha_reader]: a system role of alpha-service is named "alpha_reader"',
    ]);
  });

  it("refuses a rollback that drops a permission a custom role uses", () => {
    const problems = validate(
      doc("roles.json", {
        roles: [customRole({ permissions: ["alpha.items.write"] })],
      }),
      doc("alpha.json", {
        version: "1.0.0",
        service: alpha({ permissions: [perm("alpha.items.read")] }),
      })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("roles.json");
    expect(problems[0]).toContain("alpha.json");
    expect(problems[0]).toContain("1.0.0");
    expect(problems[0]).toContain('"alpha.items.write"');
  });

  it("refuses a webhook event no service declares, and the reserved webhook.test", () => {
    expect(
      validate(
        doc("a.json", {
          service: alpha({
            access: { roles: ["tenant_resolver"], audiences: [] },
            webhooks: [
              {
                key: "k",
                events: ["ghost.thing.happened", "webhook.test"],
              },
            ],
          }),
        })
      )
    ).toEqual([
      'a.json: services[alpha-service]: webhooks[k]: event "ghost.thing.happened" is declared by no service in the set nor by core',
      'a.json: services[alpha-service]: webhooks[k]: event "webhook.test" is reserved',
    ]);
  });

  it("refuses a webhook its owner could not read", () => {
    const withAccess = (roles: string[]) =>
      validate(
        doc("a.json", {
          service: alpha({
            access: { roles, audiences: [] },
            webhooks: [{ key: "k", events: ["beta.item.created"] }],
          }),
        }),
        doc("b.json", { service: beta() })
      );
    expect(withAccess([])).toEqual([
      "a.json: services[alpha-service]: webhooks[k]: alpha-service could not read beta.item.created (needs beta.items.read); add a role granting it to access.roles",
    ]);
    expect(withAccess(["beta-service/beta_reader"])).toEqual([]);
  });

  it("explains that a service cannot read its own event through its own roles", () => {
    expect(
      validate(
        doc("a.json", {
          service: alpha({
            webhooks: [{ key: "k", events: ["alpha.item.created"] }],
          }),
        })
      )
    ).toEqual([
      "a.json: services[alpha-service]: webhooks[k]: alpha-service could not read alpha.item.created (needs alpha.items.read); a service's account does not hold its own permissions, so add to access.roles a role of another service or a requestable core role granting it",
    ]);
  });

  it("reads a core event through a requestable core role", () => {
    const withAccess = (roles: string[]) =>
      validate(
        doc("a.json", {
          service: alpha({
            access: { roles, audiences: [] },
            webhooks: [{ key: "k", events: ["auth.organization.created"] }],
          }),
        })
      );
    expect(withAccess([])).toEqual([
      "a.json: services[alpha-service]: webhooks[k]: alpha-service could not read auth.organization.created (needs organizations.read); add a role granting it to access.roles",
    ]);
    expect(withAccess(["tenant_resolver"])).toEqual([]);
  });

  it("refuses a system role granting another service's permission", () => {
    const problems = validate(
      doc("a.json", {
        service: alpha({
          systemRoles: [
            {
              name: "alpha_sneaky",
              displayName: "Sneaky",
              description: "",
              permissions: ["alpha.items.read", "beta.items.read"],
            },
          ],
        }),
      }),
      doc("b.json", { service: beta() })
    );
    expect(problems).toContain(
      'a.json: services[alpha-service]: system role "alpha_sneaky" grants permissions this declaration does not declare: beta.items.read'
    );
  });

  it("refuses an event type read with a permission nobody declares", () => {
    const problems = validate(
      doc("a.json", {
        service: alpha({
          eventTypes: [
            {
              eventType: "alpha.item.created",
              description: "",
              readPermission: "nobody.read",
            },
          ],
        }),
      })
    );
    expect(problems).toContain(
      "a.json: services[alpha-service]: event types read with a permission neither this declaration nor core declares: alpha.item.created (nobody.read)"
    );
  });

  it("passes declaration rules through, prefixed with the file", () => {
    const problems = validate(
      doc("a.json", {
        service: alpha({
          permissions: [perm("alpha.items.read"), perm("beta.items.read")],
          systemRoles: [
            {
              name: "reader",
              displayName: "Reader",
              description: "",
              permissions: ["alpha.items.read"],
            },
          ],
        }),
      })
    );
    expect(problems.length).toBeGreaterThanOrEqual(2);
    for (const p of problems)
      expect(p.startsWith("a.json: services[alpha-service]: ")).toBe(true);
    expect(problems.some((p) => p.includes("beta.items.read"))).toBe(true);
    expect(problems.some((p) => p.includes('"alpha_"'))).toBe(true);
  });
});
