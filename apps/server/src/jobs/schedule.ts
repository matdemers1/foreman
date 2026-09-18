import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
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
