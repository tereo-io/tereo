// @module-tag int
// @module-tag platform
import { poolConfig, prisma } from "../../../utils/db/prisma.js";
import { describe, it, expect } from "vitest";
import { Pool } from "pg";

describe("poolConfig", () => {
  it("is UTC whatever the server's default", async () => {
    const [{ current_database: database }] = await prisma.$queryRaw<
      { current_database: string }[]
    >`SELECT current_database()`;
    const showTimezone = async (pool: Pool) => {
      try {
        const { rows } = await pool.query<{ TimeZone: string }>(
          "SHOW timezone"
        );
        return rows[0].TimeZone;
      } finally {
        await pool.end();
      }
    };

    await prisma.$executeRawUnsafe(
      `ALTER DATABASE "${database}" SET timezone = 'America/New_York'`
    );
    try {
      expect(
        await showTimezone(
          new Pool({ connectionString: poolConfig.connectionString, max: 1 })
        )
      ).toBe("America/New_York");
      expect(
        await showTimezone(new Pool({ ...poolConfig, min: 0, max: 1 }))
      ).toBe("UTC");
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER DATABASE "${database}" RESET timezone`
      );
    }
  });
});
