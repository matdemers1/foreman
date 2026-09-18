import { ConfigError, loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { buildRegistry, drainOne, enqueue } from '../jobs/index.js';
import { logger } from '../logger.js';

/**
 * Run one job now, and wait for it.
 *
 * This is how the restore drill is *performed* rather than documented (FRM-REQ-145), and how a
 * backup is taken on demand before something risky. It runs the real stages through the real
 * runner — not a parallel code path that might diverge from what the worker does nightly.
 *
 * ```console
 * $ docker compose exec server node dist/cli/run-job.js restore-drill
 * ```
 */

const kind = process.argv[2];
const payload = process.argv[3];

if (kind === undefined) {
  process.stderr.write('usage: run-job <kind> [json-payload]\n');
  process.exit(2);
}

const config = (() => {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.problems) process.stderr.write(`  - ${problem}\n`);
      process.exit(1);
    }
    throw error;
  }
})();

const db = createDb(config.DATABASE_URL);
const registry = buildRegistry({ config });

if (!registry.has(kind)) {
  process.stderr.write(`no job kind "${kind}". Known: ${registry.kinds().join(', ')}\n`);
  process.exit(2);
}

const { id } = await enqueue(db, registry, kind, {
  ...(payload === undefined ? {} : { payload: JSON.parse(payload) as Record<string, unknown> }),
});
process.stdout.write(`queued ${kind} as ${id}\n`);

const outcome = await drainOne({ db, logger, registry, workerId: 'cli' });

if (outcome === null) {
  // Another worker took it. Not an error, but the caller asked to watch this one run.
  process.stdout.write('nothing was claimable — a worker may have taken it first\n');
  await db.$disconnect();
  process.exit(0);
}

const job = await db.job.findUniqueOrThrow({
  where: { id: outcome.jobId },
  include: { stages: { orderBy: { sortOrder: 'asc' } } },
});

for (const stage of job.stages) {
  process.stdout.write(
    `  ${stage.name}: ${stage.status}${stage.lastError === null ? '' : ` — ${stage.lastError}`}\n`,
  );
  if (stage.output !== null) {
    process.stdout.write(`    ${JSON.stringify(stage.output)}\n`);
  }
}

process.stdout.write(`${kind}: ${outcome.status}\n`);
await db.$disconnect();
process.exit(outcome.status === 'succeeded' ? 0 : 1);
