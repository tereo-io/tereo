// @module-tag unit
// @module-tag provisioning
import { validateSet } from "../../../utils/provisioning/validate.js";
import { describe, expect, it } from "vitest";
import type {
  LoadedDocument,
  ResolvedService,
} from "../../../utils/provisioning/load.js";

const service: ResolvedService = {
  name: "alpha-service",
  namespace: "alpha",
  clientId: "alpha-service",
  internalHost: null,
  secretEnv: "ALPHA_SECRET",
  secretHash: "hash",
  access: { roles: [], audiences: [] },
  permissions: [
    {
      name: "alpha.items.read",
      displayName: "Read",
      description: "",
      orgAssignable: true,
    },
    {
      name: "alpha.items.admin",
      displayName: "Admin",
      description: "",
      orgAssignable: false,
    },
  ],
  systemRoles: [],
  buckets: [],
  eventTypes: [],
  webhooks: [],
  slug: "alpha-service",
} as unknown as ResolvedService;

const role = (
  name: string,
  extra: Partial<LoadedDocument["roles"][number]> = {}
): LoadedDocument["roles"][number] => ({
  name,
  displayName: name,
  orgAssignable: true,
  requires2fa: false,
  guestAssignable: true,
  permissions: ["alpha.items.read"],
  ...extra,
});

const doc = (
  file: string,
  body: Partial<Pick<LoadedDocument, "roles" | "guests">>,
  withService = false
): LoadedDocument => ({
  file,
  version: "1.0.0",
  service: withService ? service : null,
  clients: [],
  roles: body.roles ?? [],
  ...(body.guests && { guests: body.guests }),
});

const validate = (...documents: LoadedDocument[]) => validateSet({ documents });

describe("guest-assignable provisioned roles", () => {
  it("accepts a valid set", () => {
    expect(
      validate(
        doc(
          "a.json",
          {
            roles: [
              role("guest-reader", {
                permissions: ["alpha.items.read", "file-service.objects.read"],
              }),
            ],
            guests: { defaultRoles: ["guest-reader"] },
          },
          true
        )
      )
    ).toEqual([]);
  });

  it("rejects guestAssignable without orgAssignable", () => {
    const problems = validate(
      doc("a.json", { roles: [role("r", { orgAssignable: false })] }, true)
    );
    expect(problems.join("\n")).toContain("must also be org-assignable");
  });

  it("rejects a permission that is not org-assignable", () => {
    const problems = validate(
      doc(
        "a.json",
        { roles: [role("r", { permissions: ["alpha.items.admin"] })] },
        true
      )
    );
    expect(problems.join("\n")).toContain('"alpha.items.admin"');
  });

  it("rejects a core permission outside the guest floor", () => {
    const problems = validate(
      doc("a.json", {
        roles: [role("r", { permissions: ["users.read"] })],
      })
    );
    expect(problems.join("\n")).toContain('"users.read"');
  });

  it("rejects guests declared in two documents", () => {
    const problems = validate(
      doc("a.json", {
        roles: [role("r", { permissions: ["file-service.objects.read"] })],
        guests: { defaultRoles: ["r"] },
      }),
      doc("b.json", { guests: { defaultRoles: [] } })
    );
    expect(problems.join("\n")).toContain("more than one document");
  });

  it("rejects a default role that is not a guest-assignable role of the set", () => {
    const problems = validate(
      doc("a.json", {
        roles: [
          role("plain", {
            guestAssignable: false,
            permissions: ["file-service.objects.read"],
          }),
        ],
        guests: { defaultRoles: ["plain", "missing"] },
      })
    );
    const text = problems.join("\n");
    expect(text).toContain('"plain"');
    expect(text).toContain('"missing"');
  });
});
