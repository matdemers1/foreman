import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db.js';
import { logger } from '../../src/logger.js';
import { claim, drainOne, enqueue, JobRegistry, replayStage, runJob } from '../../src/jobs/index.js';
import { NothingToDo } from '../../src/jobs/types.js';

/**
 * FRM-REQ-141 — a stage forced to fail re-runs **alone**, without repeating the stages before it.
 *
 * This is the whole reason the queue is a table of stages rather than a queue of opaque jobs. The
 * failure mode it prevents is the expensive one: a six-hour backfill that dies on its last step and
 * can only be retried from the beginning.
 */

const url = process.env['DATABASE_URL'];

describe.skipIf(url === undefined)('job queue', () => {
  let db: Db;
  /** Counts how many times each stage actually executed, across every attempt. */
  let runs: Record<string, number>;
  let failSecond = false;

  const registry = new JobRegistry().register({
    kind: 'test-three-stages',
    stages: [
      {
        name: 'first',
        run: () => {
          runs['first'] = (runs['first'] ?? 0) + 1;
          return Promise.resolve({ fetched: 10 });
        },
      },
      {
        name: 'second',
        run: (ctx) => {
          runs['second'] = (runs['second'] ?? 0) + 1;
          if (failSecond) throw new Error('the network went away');
          return Promise.resolve({ sawFirst: ctx.priorOutput['first'] });
        },
      },
      {
        name: 'third',
        run: (ctx) => {
          runs['third'] = (runs['third'] ?? 0) + 1;
          return Promise.resolve({ sawSecond: ctx.priorOutput['second'] });
        },
      },
    ],
  });

  registry.register({
    kind: 'test-nothing-to-do',
    stages: [
      {
        name: 'first',
        run: () => {
          runs['first'] = (runs['first'] ?? 0) + 1;
          return Promise.resolve({ fetched: 10 });
        },
      },
      {
        name: 'absent',
        run: () => {
          runs['absent'] = (runs['absent'] ?? 0) + 1;
          throw new NothingToDo('the GitHub App is not configured');
        },
      },
      {
        name: 'third',
        run: () => {
          runs['third'] = (runs['third'] ?? 0) + 1;
          return Promise.resolve({ ok: true });
        },
      },
    ],
  });

  const deps = () => ({ db, logger, registry, workerId: 'test-worker' });

  beforeAll(() => {
    db = createDb(url ?? '');
  });

  beforeEach(async () => {
    runs = {};
    failSecond = false;
    await db.job.deleteMany({ where: { kind: { startsWith: 'test-' } } });
  });

  afterAll(async () => {
    await db.job.deleteMany({ where: { kind: { startsWith: 'test-' } } });
    await db.$disconnect();
  });

  it('runs every stage in order and records each output', async () => {
    const { id } = await enqueue(db, registry, 'test-three-stages');
    const claimed = await claim(db, 'test-worker');
    expect(claimed?.id).toBe(id);

    const outcome = await runJob(deps(), id);
    expect(outcome.status).toBe('succeeded');
    expect(outcome.ran).toEqual(['first', 'second', 'third']);

    const stages = await db.jobStage.findMany({ where: { jobId: id }, orderBy: { sortOrder: 'asc' } });
    expect(stages.map((s) => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(stages[1]?.output).toEqual({ sawFirst: { fetched: 10 } });
  });

  it('replays only the failed stage, leaving the earlier ones untouched', async () => {
    failSecond = true;
    const { id } = await enqueue(db, registry, 'test-three-stages');
    await claim(db, 'test-worker');

    const failed = await runJob(deps(), id);
    expect(failed.status).toBe('failed');
    expect(failed.failedStage).toBe('second');
    expect(runs).toEqual({ first: 1, second: 1 });

    // The third stage never ran, and the first is recorded as done with its output intact.
    const afterFailure = await db.jobStage.findMany({
      where: { jobId: id },
      orderBy: { sortOrder: 'asc' },
    });
    expect(afterFailure.map((s) => s.status)).toEqual(['succeeded', 'failed', 'queued']);
    expect(afterFailure[0]?.output).toEqual({ fetched: 10 });
    expect(afterFailure[1]?.lastError).toContain('the network went away');

    // Fix the world, replay that one stage.
    failSecond = false;
    await replayStage(db, id, 'second');

    const claimed = await claim(db, 'test-worker');
    expect(claimed?.id).toBe(id);
    const replayed = await runJob(deps(), id);

    expect(replayed.status).toBe('succeeded');
    // The point of the requirement, stated twice: skipped, not re-run.
    expect(replayed.skipped).toEqual(['first']);
    expect(replayed.ran).toEqual(['second', 'third']);
    expect(runs).toEqual({ first: 1, second: 2, third: 1 });
  });

  it('hands a replayed stage the output the first stage recorded on the earlier attempt', async () => {
    failSecond = true;
    const { id } = await enqueue(db, registry, 'test-three-stages');
    await claim(db, 'test-worker');
    await runJob(deps(), id);

    failSecond = false;
    await replayStage(db, id, 'second');
    await claim(db, 'test-worker');
    await runJob(deps(), id);

    const second = await db.jobStage.findFirstOrThrow({ where: { jobId: id, name: 'second' } });
    // `first` did not run this time; its output came out of the table.
    expect(second.output).toEqual({ sawFirst: { fetched: 10 } });
  });

  it('gives up after maxAttempts and leaves the job failed for inspection', async () => {
    failSecond = true;
    const { id } = await enqueue(db, registry, 'test-three-stages', { maxAttempts: 1 });
    await claim(db, 'test-worker');
    await runJob(deps(), id);

    const job = await db.job.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe('failed');
    expect(job.lastError).toContain('second: the network went away');
    expect(job.finishedAt).not.toBeNull();
  });

  it('returns the same job for a repeated idempotency key instead of queueing twice', async () => {
    const first = await enqueue(db, registry, 'test-three-stages', { idempotencyKey: 'delivery-1' });
    const second = await enqueue(db, registry, 'test-three-stages', { idempotencyKey: 'delivery-1' });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(await db.job.count({ where: { kind: 'test-three-stages' } })).toBe(1);
  });

  it('refuses to enqueue a kind nothing knows how to run', async () => {
    await expect(enqueue(db, registry, 'test-not-registered')).rejects.toThrow(/no job definition/);
  });

  it('does not claim a job scheduled for later', async () => {
    await enqueue(db, registry, 'test-three-stages', {
      availableAt: new Date(Date.now() + 60_000),
    });
    expect(await claim(db, 'test-worker')).toBeNull();
  });

  it('reclaims a job whose worker died, once its lease has expired', async () => {
    const { id } = await enqueue(db, registry, 'test-three-stages');
    await claim(db, 'dead-worker');
    // Nothing else may take it while the lease holds.
    expect(await claim(db, 'live-worker')).toBeNull();

    await db.job.update({ where: { id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    const reclaimed = await claim(db, 'live-worker');
    expect(reclaimed?.id).toBe(id);
  });

  it('drains an empty queue without doing anything', async () => {
    expect(await drainOne(deps())).toBeNull();
  });

  describe('a stage with nothing to do is not a failure', () => {
    it('succeeds, carries on, and records why', async () => {
      // An optional integration that is not configured, and a job whose subject has been deleted,
      // are both answers rather than faults. They were dead-lettering: three `reconcile-repo` rows
      // naming a repo removed at the cutover held `/health` at `ok: false` from that day on, and a
      // health endpoint permanently red for an expected reason is one nobody reads.
      const { id } = await enqueue(db, registry, 'test-nothing-to-do');
      const result = await runJob(deps(), id);

      expect(result.status).toBe('succeeded');
      expect(result.ran).toEqual(['first', 'absent', 'third']);

      const job = await db.job.findUniqueOrThrow({ where: { id } });
      expect(job.status).toBe('succeeded');
      expect(job.lastError).toBeNull();

      const stage = await db.jobStage.findFirstOrThrow({ where: { jobId: id, name: 'absent' } });
      expect(stage.status).toBe('succeeded');
      expect(stage.lastError).toBeNull();
      // The reason is the output, so "ran, found nothing" is legible afterwards.
      const output = stage.output as { skipped: boolean; because: string };
      expect(output.skipped).toBe(true);
      expect(output.because).toContain('GitHub');
    });

    it('does not count against the health endpoint, even out of attempts', async () => {
      // The property that actually matters: `/health` answers `ok: failed === 0`, and these three
      // rows held it false for days. `maxAttempts: 1` is the state production was in — the retries
      // were already spent — because a job merely queued for another go is not yet counted, and a
      // test that never exhausts them would pass with the fix removed.
      const { id } = await enqueue(db, registry, 'test-nothing-to-do', { maxAttempts: 1 });
      await runJob(deps(), id);

      const failed = await db.job.count({ where: { kind: 'test-nothing-to-do', status: 'failed' } });
      expect(failed).toBe(0);
      expect((await db.job.findUniqueOrThrow({ where: { id } })).status).toBe('succeeded');
    });

    it('still fails a stage that genuinely failed', async () => {
      // The distinction has to cut both ways, or it is just a way to make errors disappear.
      failSecond = true;
      const { id } = await enqueue(db, registry, 'test-three-stages');
      const result = await runJob(deps(), id);

      expect(result.status).toBe('failed');
      expect(result.failedStage).toBe('second');
    });
  });
});
