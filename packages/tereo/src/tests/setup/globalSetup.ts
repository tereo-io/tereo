import type { ServerInstance } from "../../index.js";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

let server: ServerInstance | null = null;

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

export async function setup() {
  // globalSetup runs in the main vitest process, where the config's `env`
  // option doesn't apply — load the same environment the workers get.
  const { loadTestEnv } = await import("./testEnv.js");
  Object.assign(process.env, loadTestEnv());
  // Only the server, which runs in this process, needs it: connection tests
  // point it at a fake SMTP server on localhost. Dropped again once the
  // server is up so the workers, which inherit this environment, keep the default.
  process.env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = "true";

  // Bring the test database up to date. Non-destructive: migrations apply
  // forward and the seed is idempotent; tests clean up what they create.
  const run = (args: string[]) =>
    execFileSync("npx", args, {
      cwd: packageRoot,
      env: process.env,
      stdio: ["ignore", "ignore", "inherit"],
    });
  run(["prisma", "migrate", "deploy"]);
  run(["tsx", "src/scripts/seed.ts"]);

  const { prisma } = await import("../../utils/db/prisma.js");
  const { hashPassword } = await import("../../utils/crypto.js");

  // Auth's admin-client tests register clients owned by this user. Created
  // here, not per worker, so parallel creation can't race.
  const owner = await prisma.user.upsert({
    where: { email: "test-client-owner@test.local" },
    update: {},
    create: {
      email: "test-client-owner@test.local",
      passwordHash: await hashPassword("TestPassword123!"),
      name: "Test Client Owner",
      isActive: true,
    },
  });

  // Core's own permissions and roles, which fixtures and tests build on. The
  // server registers them again on start; unchanged, that is a no-op.
  const { ensureDefaultOrganization } =
    await import("../../utils/defaultOrganization.js");
  const { registerCore } = await import("../../utils/coreRegistration.js");
  await ensureDefaultOrganization();
  await registerCore();

  // Users and organizations the suites reference by fixed id, and the test
  // service that owns what tests create directly.
  const { seedTestFixtures } = await import("../support/principals.js");
  await seedTestFixtures();

  // Setup is done for the suite; tests/setup/ puts it back to pending
  // around its own cases.
  await prisma.instance.update({
    where: { id: 1 },
    data: { setupCompletedAt: new Date(), setupCompletedBy: owner.id },
  });

  const { createAppServer } = await import("../../index.js");
  server = createAppServer(Number(process.env.PORT ?? 4001));
  await server.start();
  delete process.env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS;
}

export async function teardown() {
  const files = await import("../support/files.js");
  const webhooks = await import("../support/webhooks.js");
  const audit = await import("../support/audit.js");
  const provisioning = await import("../support/provisioning.js");
  for (const cleanup of [
    files.cleanupAllTestEntities,
    webhooks.cleanupAllTestEntities,
    audit.cleanupAllTestEntities,
    provisioning.cleanupAllTestEntities,
  ]) {
    await cleanup().catch(() => undefined);
  }

  await server?.stop();
  server = null;
  // A lingering ioredis socket can keep the process alive. Force the exit
  // if so, keeping the exit code vitest sets — an unconditional exit(0)
  // would report a failing run as passing.
  setTimeout(() => process.exit(), 5000).unref();
}
