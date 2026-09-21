import { Prisma, type Db } from '../db.js';
import type { Logger } from '../logger.js';
import { backoffMs, claim, heartbeat, LEASE_MS } from './queue.js';
import { NothingToDo, type JobRegistry, type StageContext } from './types.js';

/**
 * Runs a claimed job's stages in order, **skipping the ones already recorded as succeeded**.
 *
 * That skip is the requirement (FRM-REQ-141): a stage forced to fail re-runs alone, without
 * repeating the work before it. A stage's output is persisted as it finishes, so the stage after it
 * can read it on a later attempt in a different process.
 */

export interface RunOutcome {
  readonly jobId: string;
  readonly status: 'succeeded' | 'failed';
  /** Stages actually executed on this attempt — the ones that were skipped are not listed. */
  readonly ran: string[];
  readonly skipped: string[];
  readonly failedStage?: string;
}

export interface RunDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly registry: JobRegistry;
  readonly workerId: string;
}

export async function runJob(deps: RunDeps, jobId: string): Promise<RunOutcome> {
  const { db, logger, registry, workerId } = deps;

  const job = await db.job.findUniqueOrThrow({
    where: { id: jobId },
    include: { stages: { orderBy: { sortOrder: 'asc' } } },
  });
  const definition = registry.get(job.kind);

  const priorOutput: Record<string, unknown> = {};
  const ran: string[] = [];
  const skipped: string[] = [];

  // Keep the lease alive while a long stage runs.
  const keepalive = setInterval(() => {
    void heartbeat(db, jobId, workerId);
  }, LEASE_MS / 3);

  try {
    for (const stageRow of job.stages) {
      if (stageRow.status === 'succeeded') {
        priorOutput[stageRow.name] = stageRow.output;
        skipped.push(stageRow.name);
        continue;
      }

      const stage = definition.stages.find((s) => s.name === stageRow.name);
      if (stage === undefined) {
        // The definition changed under a queued job. Refuse rather than silently skip.
        throw new Error(`job kind "${job.kind}" no longer defines stage "${stageRow.name}"`);
      }

      await db.jobStage.update({
        where: { id: stageRow.id },
        data: { status: 'running', startedAt: new Date(), attempts: { increment: 1 } },
      });

      const context: StageContext = {
        db,
        logger: logger.child({ jobId, kind: job.kind, stage: stage.name }),
        jobId,
        payload: (job.payload ?? {}) as Record<string, unknown>,
        priorOutput,
      };

      try {
        const output = await stage.run(context);
        await db.jobStage.update({
          where: { id: stageRow.id },
          data: {
            status: 'succeeded',
            finishedAt: new Date(),
            // `Prisma.JsonNull` is a JSON null in the column; a bare `null` is rejected.
            output: output === undefined ? Prisma.JsonNull : (output as Prisma.InputJsonValue),
            lastError: null,
          },
        });
        priorOutput[stage.name] = output;
        ran.push(stage.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // A stage with nothing to do has not failed. Recorded as succeeded with the reason as its
        // output, so the job reads as "ran, found nothing" rather than as a fault — and, more to
        // the point, so it stops counting against `/health`. Not retried either: an absent
        // integration and a deleted subject are both answers, and asking again gets the same one.
        if (error instanceof NothingToDo) {
          const output = { skipped: true, because: error.because };
          await db.jobStage.update({
            where: { id: stageRow.id },
            data: {
              status: 'succeeded',
              finishedAt: new Date(),
              output,
              lastError: null,
            },
          });
          priorOutput[stage.name] = output;
          ran.push(stage.name);
          logger.info(
            { jobId, stage: stage.name, because: error.because },
            'stage had nothing to do',
          );
          continue;
        }

        await db.jobStage.update({
          where: { id: stageRow.id },
          data: { status: 'failed', finishedAt: new Date(), lastError: message },
        });

        const exhausted = job.attempts >= job.maxAttempts;
        await db.job.update({
          where: { id: jobId },
          data: {
            status: exhausted ? 'failed' : 'queued',
            lastError: `${stage.name}: ${message}`,
            lockedBy: null,
            lockedAt: null,
            leaseUntil: null,
            availableAt: new Date(Date.now() + backoffMs(job.attempts)),
            ...(exhausted ? { finishedAt: new Date() } : {}),
          },
        });
        logger.error({ jobId, stage: stage.name, err: message, exhausted }, 'job stage failed');
        return { jobId, status: 'failed', ran, skipped, failedStage: stage.name };
      }
    }

    await db.job.update({
      where: { id: jobId },
      data: {
        status: 'succeeded',
        finishedAt: new Date(),
        lockedBy: null,
        lockedAt: null,
        leaseUntil: null,
        lastError: null,
      },
    });
    logger.info({ jobId, kind: job.kind, ran, skipped }, 'job succeeded');
    return { jobId, status: 'succeeded', ran, skipped };
  } finally {
    clearInterval(keepalive);
  }
}

/** Claim and run one job, if any is due. Returns null when the queue is empty. */
export async function drainOne(deps: RunDeps): Promise<RunOutcome | null> {
  const claimed = await claim(deps.db, deps.workerId);
  if (claimed === null) return null;
  return runJob(deps, claimed.id);
}
