// @module-tag int
// @module-tag auth
// @module-tag platform
// @module-tag race
import { describe, expect, it, vi } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import {
  currentSigningKey,
  publishedSigningKeys,
  refreshSigningKeys,
  rotateSigningKey,
} from "../../utils/keys.js";

/**
 * Overlapping refreshes of the signing keys (the periodic one, an unknown
 * kid's, a rotation's) in this process. The first read is held until the
 * rotation has finished, so it lands last. The immediate key is left in
 * place: the rotation deleted every key before it.
 */
describe("refreshSigningKeys", () => {
  describe("signing key refresh", () => {
    it("does not undo an immediate rotation with a read from before it", async () => {
      await refreshSigningKeys();
      const before = currentSigningKey().kid;

      const findMany = prisma.secret.findMany.bind(prisma.secret);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let held = false;
      const spy = vi.spyOn(prisma.secret, "findMany").mockImplementation(((
        args: unknown
      ) => {
        const rows = (findMany as (a: unknown) => Promise<unknown>)(args);
        if (held) return rows;
        held = true;
        return rows.then(async (r) => {
          await gate;
          return r;
        });
      }) as never);

      try {
        const staleRefresh = refreshSigningKeys();
        await new Promise((resolve) => setTimeout(resolve, 200));

        const { keys } = await rotateSigningKey({ immediate: true });
        const active = keys.find((k) => k.active)!;
        expect(active.kid).not.toBe(before);
        expect(currentSigningKey().kid).toBe(active.kid);

        release();
        await staleRefresh;

        expect(currentSigningKey().kid).toBe(active.kid);
        expect(publishedSigningKeys().map((k) => k.kid)).toContain(active.kid);
      } finally {
        release();
        spy.mockRestore();
      }
    });
  });
});
