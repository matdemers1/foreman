import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import { ALERTS, type Mailer } from '../adapters/mail.js';
import { enqueue } from './queue.js';
import type { JobRegistry } from './types.js';

/**
 * The nightly reconcile (T-5.5, FRM-REQ-103).
 *
 * No cron daemon and no second process: the worker asks, on every idle tick, whether today's
 * reconcile has been enqueued yet. The **idempotency key carries the date**, so a thousand ticks
 * enqueue one job, and a worker restarted at noon still gets that day's run rather than skipping
 * it because a timer was reset.
 *
 * This is deliberately coarse. A reconcile is a safety net for dropped deliveries, not a data
 * path — being a few hours late costs nothing, and the webhook is what makes Foreman current.
 */

/** UTC, so a machine moving between time zones does not get two reconciles or none. */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface ScheduleResult {
  readonly enqueued: string[];
  readonly repos: number;
}

/**
 * The nightly dump and the weekly drill (T-7.6, T-7.7).
 *
 * Same trick as the reconcile: the idempotency key carries the date, so asking every minute
 * enqueues one job. The drill is weekly rather than nightly — it restores a whole database, and
 * once a week is often enough to catch a dump that stopped working without spending an hour a day
 * proving one that still does.
 */
export async function scheduleMaintenance(
  db: Db,
  registry: JobRegistry,
  logger: Logger,
  now = new Date(),
): Promise<{ enqueued: string[] }> {
  const enqueued: string[] = [];

  if (registry.has('backup')) {
    const backup = await enqueue(db, registry, 'backup', {
      idempotencyKey: `backup:${dayKey(now)}`,
    });
    if (backup.created) {
      enqueued.push('backup');
      logger.info({ day: dayKey(now) }, 'nightly dump scheduled');
    }
  }

  if (registry.has('restore-drill')) {
    const drill = await enqueue(db, registry, 'restore-drill', {
      idempotencyKey: `restore-drill:${weekKey(now)}`,
    });
    if (drill.created) {
      enqueued.push('restore-drill');
      logger.info({ week: weekKey(now) }, 'restore drill scheduled');
    }
  }

  return { enqueued };
}

/**
 * Notice a stalled queue, and say so (T-7.5, FRM-REQ-143).
 *
 * Checked by the worker on the same tick as the scheduling, because the worker is the thing that
 * would be stuck — and a queue nobody is draining is exactly the condition nothing else notices.
 * The mailer deduplicates, so calling this every minute sends one email an hour at most.
 */
export async function alertOnStall(
  db: Db,
  mailer: Mailer,
  now = new Date(),
): Promise<{ alerted: boolean; depth: number }> {
  const oldest = await db.job.findFirst({
    where: { status: 'queued' },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });

  if (oldest === null || now.getTime() - oldest.createdAt.getTime() <= STALL_AFTER_MS) {
    return { alerted: false, depth: 0 };
  }

  const depth = await db.job.count({ where: { status: 'queued' } });
  const result = await mailer.send(ALERTS.queueStalled(depth, oldest.createdAt.toISOString()));
  return { alerted: result.sent, depth };
}

/** A queue whose head has waited this long is not busy, it is stuck. Matches the health screen. */
const STALL_AFTER_MS = 30 * 60 * 1000;

/** ISO week, so "once a week" does not drift with the day a worker happened to restart. */
export function weekKey(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Thursday of this week decides the year, per ISO 8601.
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${String(date.getUTCFullYear())}-W${String(week).padStart(2, '0')}`;
}

export async function scheduleReconciles(
  db: Db,
  registry: JobRegistry,
  logger: Logger,
  now = new Date(),
): Promise<ScheduleResult> {
  const repos = await db.repo.findMany({
    // Only repositories whose history has been read: reconciling one that has never been
    // backfilled would report its entire history as "healed" gaps.
    where: { deletedAt: null, backfilledAt: { not: null } },
    select: { id: true, fullName: true },
  });

  const enqueued: string[] = [];
  for (const repo of repos) {
    const result = await enqueue(db, registry, 'reconcile-repo', {
      payload: { repoId: repo.id },
      idempotencyKey: `reconcile:${repo.id}:${dayKey(now)}`,
    });
    if (result.created) {
      enqueued.push(repo.fullName);
      logger.info({ repo: repo.fullName }, 'reconcile scheduled');
    }
  }

  return { enqueued, repos: repos.length };
}
