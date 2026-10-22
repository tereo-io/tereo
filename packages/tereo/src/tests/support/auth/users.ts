import { TEST_SERVICE, TEST_SERVICE_ID } from "../testService.js";
import { CORE_SERVICE_ID } from "../../../definitions/index.js";
import { hashPassword } from "../../../utils/crypto.js";
import { prisma } from "../../../utils/db/prisma.js";
import { generateUniqueId } from "./crypto.js";

// Create test user
export async function createTestUser(
  options: {
    email?: string;
    password?: string;
    name?: string;
    isActive?: boolean;
  } = {}
) {
  const uniqueId = generateUniqueId();
  const email = options.email || `test-user-${uniqueId}@test.local`;
  const password = options.password || "TestPassword123!";

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name: options.name || `Test User ${uniqueId}`,
      isActive: options.isActive ?? true,
    },
  });

  return {
    ...user,
    passwordHash,
    plainPassword: password,
  };
}

// Create test role
export async function createTestRole(
  options: {
    name?: string;
    displayName?: string;
    description?: string;
    isSystem?: boolean;
  } = {}
) {
  const uniqueId = generateUniqueId();

  const role = await prisma.role.create({
    data: {
      // A system role is the test service's, named under its namespace.
      name:
        options.name ||
        (options.isSystem
          ? `${TEST_SERVICE.namespace}_role-${uniqueId}`
          : `test-role-${uniqueId}`),
      displayName: options.displayName || `Test Role ${uniqueId}`,
      description: options.description || "Test role for testing",
      serviceId: options.isSystem ? TEST_SERVICE_ID : null,
      isActive: true,
      requires2fa: false,
    },
  });

  return role;
}

// Create test permission
export async function createTestPermission(
  options: {
    name?: string;
    displayName?: string;
    description?: string;
  } = {}
) {
  const uniqueId = generateUniqueId();

  // Permission names must follow regex: ^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$
  // Each segment must start with a letter, so we prefix uniqueId with 'p'
  const permission = await prisma.permission.create({
    data: {
      name: options.name || `test.permission.p${uniqueId}`,
      displayName: options.displayName || `Test Permission ${uniqueId}`,
      description: options.description || "Test permission for testing",
      serviceId: TEST_SERVICE_ID,
    },
  });

  return permission;
}

// Create admin user with admin role
export async function createAdminUser() {
  const user = await createTestUser({ name: "Admin User" });

  // Core's own `admin` role, registered when the suite starts.
  const adminRole = await prisma.role.findFirstOrThrow({
    where: { name: "admin", serviceId: CORE_SERVICE_ID },
  });

  // Assign admin role to user
  await prisma.userRole.create({
    data: {
      userId: user.id,
      roleId: adminRole.id,
    },
  });

  return user;
}
