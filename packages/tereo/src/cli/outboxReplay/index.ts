import type { DeadLetterFilter } from "../../utils/db/outbox.js";
import db from "../../utils/db/index.js";
import z from "zod";

/**
 * Returns dead-lettered `core.outbox` rows to the reaper: clears
 * `dead_lettered_at` and `attempts` and makes them due now. The reaper then
 * dispatches them as it would a new row, so fix whatever dead-lettered them
 * first. Webhook rows already fanned out are completed without writing their
 * deliveries again.
 */
export interface OutboxReplayOptions extends DeadLetterFilter {
  /** Every dead letter. Required when no other filter is given. */
  all?: boolean;
  /** Count what would be replayed without changing anything. */
  dryRun?: boolean;
}

export interface OutboxReplayResult {
  dryRun: boolean;
  /** Rows reset, or that would be with `dryRun`. */
  replayed: number;
}

export class OutboxReplayUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxReplayUsageError";
  }
}

const hasFilter = (opts: OutboxReplayOptions): boolean =>
  (opts.ids?.length ?? 0) > 0 ||
  opts.destination !== undefined ||
  opts.since !== undefined;

export async function replayOutbox(
  opts: OutboxReplayOptions
): Promise<OutboxReplayResult> {
  if (!hasFilter(opts) && !opts.all) {
    throw new OutboxReplayUsageError(
      "Give --id, --destination or --since, or --all to replay every dead letter"
    );
  }
  const filter: DeadLetterFilter = {
    ids: opts.ids,
    destination: opts.destination,
    since: opts.since,
  };
  const dryRun = !!opts.dryRun;
  const replayed = dryRun
    ? await db.outbox.countDeadLetters(filter)
    : await db.outbox.replayDeadLetters(filter);
  return { dryRun, replayed };
}

const USAGE = [
  "Usage: npm run cli -- outbox-replay [options]",
  "",
  "Returns dead-lettered outbox rows to the reaper: clears the dead letter and",
  "its attempts and makes the row due now. At least one filter, or --all.",
  "",
  "Options:",
  "  --id <uuid>              Replay this row. Repeatable.",
  "  --destination <dest>     Replay rows for this destination (webhook, notification).",
  "  --since <ISO date>       Replay rows dead-lettered at or after this time.",
  "  --all                    Replay every dead letter.",
  "  --dry-run                Count what would be replayed without changing anything.",
].join("\n");

const uuid = z.string().uuid();

/** Parses argv; throws `OutboxReplayUsageError` on anything malformed. */
export function parseOutboxReplayArgs(argv: string[]): OutboxReplayOptions {
  const opts: OutboxReplayOptions = {};
  const value = (flag: string, i: number): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) {
      throw new OutboxReplayUsageError(`${flag} needs a value`);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--id") {
      const id = value(arg, ++i);
      if (!uuid.safeParse(id).success) {
        throw new OutboxReplayUsageError(`--id is not a uuid: ${id}`);
      }
      (opts.ids ??= []).push(id);
    } else if (arg === "--destination") {
      opts.destination = value(arg, ++i);
    } else if (arg === "--since") {
      const raw = value(arg, ++i);
      const since = new Date(raw);
      if (Number.isNaN(since.getTime())) {
        throw new OutboxReplayUsageError(`--since is not a date: ${raw}`);
      }
      opts.since = since;
    } else if (arg === "--all") {
      opts.all = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else {
      throw new OutboxReplayUsageError(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

export async function runOutboxReplayCli(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.error(USAGE);
    return;
  }
  let result: OutboxReplayResult;
  try {
    result = await replayOutbox(parseOutboxReplayArgs(argv));
  } catch (err) {
    if (!(err instanceof OutboxReplayUsageError)) throw err;
    console.error(err.message);
    console.error("");
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  console.log(
    result.dryRun
      ? `Would replay ${result.replayed} dead-lettered outbox row(s)`
      : `Replayed ${result.replayed} dead-lettered outbox row(s)`
  );
}
