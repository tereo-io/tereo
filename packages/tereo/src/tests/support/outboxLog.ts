import { prisma } from "../../utils/db/prisma.js";

export interface EmittedEvent {
  eventType: string;
  entityType: string;
  entityId: string;
  organizationId: string | null;
  data: unknown;
}

/**
 * Copies every row written to `core.outbox` into `test_support.outbox_log`,
 * emptied here at the start of a run.
 *
 * The server under test runs the outbox reaper, which deletes a row as soon as
 * it has dispatched it, so `core.outbox` read after a request may or may not
 * still hold the request's rows. The log keeps them.
 */
export const installOutboxLog = async (): Promise<void> => {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "test_support"`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "test_support"."outbox_log" (
      seq bigserial PRIMARY KEY,
      outbox_id uuid NOT NULL,
      destination text NOT NULL,
      payload jsonb NOT NULL
    )`);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS outbox_log_entity
      ON "test_support"."outbox_log" ((payload ->> 'entityId'))`);
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION "test_support"."log_outbox"() RETURNS trigger AS $$
    BEGIN
      INSERT INTO "test_support"."outbox_log" (outbox_id, destination, payload)
      VALUES (NEW.id, NEW.destination, NEW.payload);
      RETURN NULL;
    END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS outbox_test_log ON "core"."outbox"`
  );
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER outbox_test_log AFTER INSERT ON "core"."outbox"
    FOR EACH ROW EXECUTE FUNCTION "test_support"."log_outbox"()`);
  await prisma.$executeRawUnsafe(`TRUNCATE "test_support"."outbox_log"`);
};

/**
 * The webhook events committed for an entity, oldest first, whether or not the
 * reaper has dispatched them yet. Complete once the request that emits them
 * has answered.
 */
export const emittedEvents = async (
  entityId: string,
  eventType?: string
): Promise<EmittedEvent[]> => {
  const rows = await prisma.$queryRaw<Array<{ payload: EmittedEvent }>>`
    SELECT payload FROM "test_support"."outbox_log"
    WHERE destination = 'webhook' AND payload ->> 'entityId' = ${entityId}
    ORDER BY seq`;
  const events = rows.map((row) => row.payload);
  return eventType ? events.filter((e) => e.eventType === eventType) : events;
};
