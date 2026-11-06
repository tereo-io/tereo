import { vi } from "vitest";

/** Stands in for `@/lib/auth`: tests set `permissions` and script `axios`. */
export const authMock = {
  permissions: [] as string[],
  /** The viewer's memberships, as userinfo lists them. */
  organizations: [] as {
    id: string;
    name: string;
    slug: string;
    memberRole: string;
  }[],
  axios: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
};

export const mockAuthModule = () => ({
  useAuth: () => ({
    hasPermission: (p: string) =>
      authMock.permissions.includes(p) ||
      authMock.permissions.includes("admin"),
    organizations: authMock.organizations,
  }),
  useAxios: () => authMock.axios,
});
