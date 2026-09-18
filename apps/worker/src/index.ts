import { writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { ConfigError, loadConfig } from 'foreman-server/config';
import { createDb } from 'foreman-server/db';
import { logger } from 'foreman-server/logger';
import { buildRegistry, drainOne } from 'foreman-server/jobs';

/**
 * The worker: claim a job, run its stages, repeat. It runs no migrations and serves no requests —
 * the server owns the schema, so two processes never race to change it.
 */

const IDLE_POLL_MS = 2000;
const HEARTBEAT_PATH = process.env['WORKER_HEARTBEAT'] ?? '/tmp/worker-heartbeat';

const config = (() => {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write('foreman-worker refused to start:\n');
      for (const problem of error.problems) process.stderr.write(`  - ${problem}\n`);
      process.exit(1);
    }
    throw error;
  }
})();

const db = createDb(config.DATABASE_URL);
const registry = buildRegistry();
const workerId = `${hostname()}:${String(process.pid)}`;
const log = logger.child({ workerId });

/**
 * Shutdown is cooperative: the loop finishes the job in hand and then stops. Read through a
 * function so the flag is not narrowed to a constant — and registered *before* the loop starts,
 * since a handler installed after an endless loop is never installed at all.
 */
let stopRequested = false;
const shouldContinue = (): boolean => !stopRequested;

async function beat(): Promise<void> {
  try {
    await writeFile(HEARTBEAT_PATH, new Date().toISOString(), 'utf8');
  } catch (error) {
    // A heartbeat that cannot be written is worth knowing about, not worth stopping work for.
    log.warn({ err: error instanceof Error ? error.message : String(error) }, 'heartbeat failed');
  }
}

const heartbeat = setInterval(() => {
  void beat();
}, 30_000);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info({ signal }, 'worker stopping after the current job');
    stopRequested = true;
    clearInterval(heartbeat);
  });
}

const idle = (ms: number) => new Promise((r) => setTimeout(r, ms));

log.info({ kinds: registry.kinds() }, 'foreman-worker started');
await beat();

while (shouldContinue()) {
  try {
    const outcome = await drainOne({ db, logger: log, registry, workerId });
    // Nothing due. Poll rather than LISTEN/NOTIFY: one operator's queue is never hot enough to
    // justify a second mechanism, and a poll survives a dropped connection without ceremony.
    if (outcome === null) await idle(IDLE_POLL_MS);
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'drain loop error');
    await idle(IDLE_POLL_MS);
  }
}

log.info('worker stopped');
await db.$disconnect();
