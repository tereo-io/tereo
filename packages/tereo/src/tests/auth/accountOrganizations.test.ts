import { getTestPrincipalToken } from "../utils/principals.js";
import { describe, it, expect, beforeAll } from "vitest";
import { browserLogin } from "../utils/browserLogin.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomBytes } from "crypto";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
} from "./utils/test-helpers.js";

/**
 * GET /v1/account/organizations: the caller's active memberships, or, for a
 * holder of `organizations.support-access` searching, every active
 * organization that matches. `core:organizations` opens it and nothing else.
 */

type Client = Awaited<ReturnType<typeof createTestClient>>;
type User = Awaited<ReturnType<typeof createTestUser>>;

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  memberRole: string | null;
  member: boolean;
}

interface OrgPage {
  data: OrgRow[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

let thirdParty: Client;

beforeAll(async () => {
  thirdParty = await createTestClient();
});

const loginToken = async (user: User, scope: string) => {
  const redirectUri = thirdParty.redirectUris[0];
  const { code, verifier } = await browserLogin({
    clientId: thirdParty.clientId,
    redirectUri,
    scope,
    email: user.email,
    password: user.plainPassword,
  });
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: thirdParty.clientId,
      code_verifier: verifier,
    }),
  });
  expect(res.status).toBe(HTTP_STATUS.OK);
  return ((await res.json()) as { access_token: string }).access_token;
};

const call = (token: string, path: string) =>
  fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

const list = async (token: string, query = "") => {
  const res = await call(token, `/v1/account/organizations${query}`);
  expect(res.status).toBe(HTTP_STATUS.OK);
  return (await res.json()) as OrgPage;
};

const uid = () => randomBytes(5).toString("hex");

/** An organization named `<label> <tag>`, with slug `<label>-<tag>`. */
const makeOrg = async (
  tag: string,
  label: string,
  state: { isActive?: boolean; archived?: boolean } = {}
) =>
  prisma.organization.create({
    data: {
      name: `${label} ${tag}`,
      slug: `${label.toLowerCase()}-${tag}`,
      code: randomBytes(3).toString("hex").toUpperCase(),
      isActive: state.isActive ?? true,
      archivedAt: state.archived ? new Date() : null,
    },
  });

const join = (
  organizationId: string,
  userId: string,
  memberRole: "owner" | "admin" | "member" = "member"
) =>
  prisma.organizationMember.create({
    data: { organizationId, userId, memberRole },
  });

/**
 * A user in two active orgs and one inactive and one archived, plus one
 * active org they are not in, all tagged with one unique string. The user
 * joins at `joinAll`, after signing in: a member of several organizations
 * would be asked to choose one at login.
 */
const fixture = async () => {
  const tag = uid();
  const user = await createTestUser();
  const mine = await makeOrg(tag, "Mine");
  const owned = await makeOrg(tag, "Owned");
  const inactive = await makeOrg(tag, "Inactive", { isActive: false });
  const archived = await makeOrg(tag, "Archived", {
    isActive: false,
    archived: true,
  });
  const other = await makeOrg(tag, "Other");
  const otherInactive = await makeOrg(tag, "Gone", { isActive: false });
  const joinAll = async () => {
    await join(mine.id, user.id);
    await join(owned.id, user.id, "owner");
    await join(inactive.id, user.id);
    await join(archived.id, user.id);
  };
  return {
    tag,
    user,
    mine,
    owned,
    inactive,
    archived,
    other,
    otherInactive,
    joinAll,
  };
};

describe("GET /v1/account/organizations", () => {
  it("lists active memberships to a core:organizations-only token, which /account/me refuses", async () => {
    const f = await fixture();
    const token = await loginToken(f.user, "openid core:organizations");
    await f.joinAll();

    const page = await list(token);
    expect(page.data).toEqual(
      expect.arrayContaining([
        {
          id: f.mine.id,
          name: f.mine.name,
          slug: f.mine.slug,
          memberRole: "member",
          member: true,
        },
        {
          id: f.owned.id,
          name: f.owned.name,
          slug: f.owned.slug,
          memberRole: "owner",
          member: true,
        },
      ])
    );
    const ids = page.data.map((o) => o.id);
    expect(ids).not.toContain(f.inactive.id);
    expect(ids).not.toContain(f.archived.id);
    expect(ids).not.toContain(f.other.id);

    const me = await call(token, "/v1/account/me");
    expect(me.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(((await me.json()) as { error: string }).error).toBe(
      "insufficient_scope"
    );
  });

  it("is open to core:account too, and refuses other areas' scopes naming both", async () => {
    const f = await fixture();
    const account = await loginToken(f.user, "openid core:account");
    const files = await loginToken(f.user, "openid core:files.read");
    await f.joinAll();
    expect((await list(account)).data.map((o) => o.id).sort()).toEqual(
      [f.mine.id, f.owned.id].sort()
    );

    const res = await call(files, "/v1/account/organizations");
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("core:account");
    expect(challenge).toContain("core:organizations");
  });

  it("pages by cursor", async () => {
    const f = await fixture();
    const token = await loginToken(f.user, "openid core:organizations");
    await f.joinAll();
    const first = await list(token, "?limit=1");
    expect(first.data).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    const second = await list(
      token,
      `?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`
    );
    expect(second.data).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect([first.data[0].id, second.data[0].id].sort()).toEqual(
      [f.mine.id, f.owned.id].sort()
    );
  });

  it("searches every active organization for a support-access holder", async () => {
    const f = await fixture();
    await getTestPrincipalToken({
      userId: f.user.id,
      permissions: ["organizations.support-access"],
    });
    const token = await loginToken(f.user, "openid core:organizations");
    await f.joinAll();

    const page = await list(token, `?search=${f.tag.toUpperCase()}`);
    const byId = new Map(page.data.map((o) => [o.id, o]));
    expect([...byId.keys()].sort()).toEqual(
      [f.mine.id, f.owned.id, f.other.id].sort()
    );
    expect(byId.get(f.other.id)).toEqual({
      id: f.other.id,
      name: f.other.name,
      slug: f.other.slug,
      memberRole: null,
      member: false,
    });
    expect(byId.get(f.owned.id)).toMatchObject({
      memberRole: "owner",
      member: true,
    });

    // By slug as well as name.
    const bySlug = await list(token, `?search=other-${f.tag}`);
    expect(bySlug.data.map((o) => o.id)).toEqual([f.other.id]);

    // Without search, memberships only.
    expect((await list(token)).data.map((o) => o.id).sort()).toEqual(
      [f.mine.id, f.owned.id].sort()
    );
  });

  it("searches only memberships for a non-holder", async () => {
    const f = await fixture();
    const token = await loginToken(f.user, "openid core:organizations");
    await f.joinAll();
    const page = await list(token, `?search=${f.tag}`);
    expect(page.data.map((o) => o.id).sort()).toEqual(
      [f.mine.id, f.owned.id].sort()
    );
    const owned = await list(token, `?search=owned-${f.tag}`);
    expect(owned.data.map((o) => o.id)).toEqual([f.owned.id]);
  });

  it("searches only memberships when the token's scopes cap support access away", async () => {
    const f = await fixture();
    await getTestPrincipalToken({
      userId: f.user.id,
      permissions: ["organizations.support-access"],
    });
    const token = await loginToken(f.user, "openid core:account");
    await f.joinAll();
    const page = await list(token, `?search=${f.tag}`);
    expect(page.data.map((o) => o.id).sort()).toEqual(
      [f.mine.id, f.owned.id].sort()
    );
  });

  it("refuses a search shorter than two characters", async () => {
    const user = await createTestUser();
    const token = await loginToken(user, "openid core:organizations");
    const res = await call(token, "/v1/account/organizations?search=a");
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });
});

describe("discovery", () => {
  it("lists core:events and core:organizations in scopes_supported", async () => {
    const res = await fetch(`${BASE_URL}/.well-known/openid-configuration`);
    const { scopes_supported } = (await res.json()) as {
      scopes_supported: string[];
    };
    expect(scopes_supported).toEqual(
      expect.arrayContaining(["core:events", "core:organizations"])
    );
  });
});
