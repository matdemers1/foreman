import type { Db } from '../db.js';

/**
 * "Which phase is this project on?" — asked by the brief and by the portfolio, answered once.
 *
 * It was answered twice, and the two disagreed. The brief took the furthest-along phase; the
 * portfolio took `status: 'active'` and nothing else, so with no phase marked active — which is
 * every one of the nine projects imported at the cutover — the portfolio said `null` for a
 * project the brief could name. One question, two surfaces, two answers, and no way for a reader
 * to know which to believe.
 *
 * Phase 7 already learned this for drift: one engine, three surfaces, and a test asserting they
 * agree. The same discipline belongs here, and its absence is how the fix that taught the brief
 * to find the furthest-along phase never reached the portfolio beside it.
 */

/**
 * The active phase, or the furthest along one if none is marked active — a project mid-flight
 * always has a "where are we", even when nobody remembered to set a status.
 *
 * "Furthest along" is the point. This used to take the *first* `planned` phase ascending, which
 * is the opposite: after the cutover, Bindery — complete through Phase 20 — briefed as *Phase 0,
 * Foundation, 8 of 8 done*, because a couple of stragglers in early phases sorted first. A
 * project with two unfinished tasks in Phase 1 and twenty finished phases after it is not at
 * Phase 1.
 *
 * So: the furthest phase that has started but is not finished. Falling back to the earliest
 * unstarted one, which is where a project nobody has begun actually is.
 */
// The whole row is returned, not a narrowing: the brief reads `objective` and `exitDemo` and the
// portfolio reads three fields, and a hand-written shape here would be a third place to keep in
// step with the schema.
export async function phaseInFlight(db: Db, projectId: string) {
  const marked = await db.phase.findFirst({
    where: { projectId, status: 'active', deletedAt: null },
    orderBy: { sortOrder: 'asc' },
  });
  if (marked !== null) return marked;

  const started = await db.phase.findFirst({
    where: {
      projectId,
      status: { not: 'complete' },
      deletedAt: null,
      tasks: { some: { status: 'done', deletedAt: null } },
    },
    orderBy: { sortOrder: 'desc' },
  });
  if (started !== null) return started;

  return db.phase.findFirst({
    where: { projectId, status: { not: 'complete' }, deletedAt: null },
    orderBy: { sortOrder: 'asc' },
  });
}
