import { Prisma, type Db } from '../db.js';
import type { JobRegistry } from './types.js';

/**
 * The queue itself: Postgres rows, claimed with `FOR UPDATE SKIP LOCKED`.
 *
 * No Redis (Architecture). The queue being a table is the point — it is inspectable with a query,
 * a stuck job is visible, and a lease makes a dead worker's job reclaimable rather than lost.
 */

/** How long a claim is good for. A worker that dies holds its job only until this expires. */
export const LEASE_MS = 5 * 60 * 1000;

export interface EnqueueOptions {
  readonly payload?: Record<string, unknown>;
  /** A job that must not run twice — one webhook delivery, say. */
  readonly idempotencyKey?: string;
  readonly availableAt?: Date;
  readonly maxAttempts?: number;
}

export interface EnqueueResult {
  readonly id: string;
  /** False when an existing job with the same idempotency key was returned instead. */
  readonly created: boolean;
}

export async function enqueue(
  db: Db,
  registry: JobRegistry,
  kind: string,
  options: EnqueueOptions = {},
): Promise<EnqueueResult> {
  // Fail here, at enqueue time, rather than in a worker at 3am.
  const definition = registry.get(kind);

  if (options.idempotencyKey !== undefined) {
    const existing = await db.job.findUnique({ where: { idempotencyKey: options.idempotencyKey } });
    if (existing !== null) return { id: existing.id, created: false };
  }

  const job = await db.job.create({
    data: {
      kind,
      payload: (options.payload ?? {}) as Prisma.InputJsonObject,
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(options.availableAt !== undefined ? { availableAt: options.availableAt } : {}),
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
      stages: {
        create: definition.stages.map((stage, index) => ({ name: stage.name, sortOrder: index })),
      },
    },
  });
  return { id: job.id, created: true };
}

export interface ClaimedJob {
  readonly id: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly maxAttempts: number;
}

/**
 * Claim one runnable job. `SKIP LOCKED` is what lets a second worker take the next job instead of
 * waiting behind the first.
 */
export async function claim(db: Db, workerId: string): Promise<ClaimedJob | null> {
  const now = new Date();
  const lease = new Date(now.getTime() + LEASE_MS);

  const rows = await db.$queryRaw<
    { id: string; kind: string; payload: unknown; attempts: number; max_attempts: number }[]
  >`
    update job set
      status = 'running',
      locked_by = ${workerId},
      locked_at = ${now},
      lease_until = ${lease},
      started_at = coalesce(started_at, ${now}),
      attempts = attempts + 1,
      updated_at = ${now}
    where id = (
      select id from job
      where available_at <= ${now}
        and (
          status = 'queued'
          -- Reclaim a job whose worker died mid-flight: the lease, not a timeout, is the signal.
          or (status = 'running' and lease_until < ${now})
        )
      order by available_at asc
      for update skip locked
      limit 1
    )
    returning id, kind, payload, attempts, max_attempts
  `;

  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    kind: row.kind,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

/** Extend the lease of a job still being worked on. */
export async function heartbeat(db: Db, jobId: string, workerId: string): Promise<void> {
  await db.job.updateMany({
    where: { id: jobId, lockedBy: workerId },
    data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
  });
}

/**
 * Reset one stage to `queued` so it runs again — and only it. The stages before it keep their
 * `succeeded` status and their recorded output, which is what makes this cheap.
 */
export async function replayStage(db: Db, jobId: string, stageName: string): Promise<void> {
  const stage = await db.jobStage.findUnique({
    where: { jobId_name: { jobId, name: stageName } },
  });
  if (stage === null) throw new Error(`job ${jobId} has no stage "${stageName}"`);

  await db.$transaction([
    db.jobStage.update({
      where: { id: stage.id },
      data: { status: 'queued', lastError: null, startedAt: null, finishedAt: null },
    }),
    db.job.update({
      where: { id: jobId },
      data: {
        status: 'queued',
        lockedBy: null,
        lockedAt: null,
        leaseUntil: null,
        availableAt: new Date(),
        finishedAt: null,
        lastError: null,
      },
    }),
  ]);
}

/** Queue depth by status, for `/health`. */
export async function queueDepth(db: Db): Promise<Record<string, number>> {
  const grouped = await db.job.groupBy({ by: ['status'], _count: { _all: true } });
  return Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
}

/** Exponential backoff with a ceiling, so a failing dependency is not hammered. */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1) * 1000, 5 * 60 * 1000);
}
