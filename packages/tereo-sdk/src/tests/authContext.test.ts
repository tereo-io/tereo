import { authContextFromIntrospection, hasPermission } from "../index.js";
import { expect, it } from "vitest";

it("maps an introspection to the AuthContext requireAuth sets", () => {
  const ctx = authContextFromIntrospection({
    active: true,
    iss: "https://core",
    sub: "u1",
    user_id: "u1",
    aud: "svc",
    exp: 2,
    iat: 1,
    jti: "j",
    scope: "openid  profile",
    client_id: "c1",
    permissions: ["a.b.read"],
    org_id: "o1",
    org_name: "Org",
  });
  expect(ctx).toMatchObject({
    userId: "u1",
    userType: "human",
    clientId: "c1",
    scope: ["openid", "profile"],
    audience: ["svc"],
    permissions: ["a.b.read"],
    organizationId: "o1",
    email: null,
    currentSessionId: null,
  });
});

it("marks a client_credentials token as a service account", () => {
  const ctx = authContextFromIntrospection({
    active: true,
    iss: "i",
    sub: "c1",
    user_id: "sa1",
    exp: 2,
    iat: 1,
    jti: "j",
    scope: "",
    client_id: "c1",
  });
  expect(ctx.userType).toBe("service_account");
});

it("exports the hierarchical permission check", () => {
  expect(hasPermission(["a.b.write"], "a.b.read")).toBe(true);
  expect(hasPermission(["a.b.read"], "a.b.write")).toBe(false);
});
