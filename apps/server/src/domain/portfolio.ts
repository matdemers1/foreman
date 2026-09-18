import type { Db } from '../db.js';
import { driftFor } from './drift.js';

/**
 * The portfolio — one row per project, answering "where is everything" at a glance
 * (FRM-REQ-133).
 *
 * **Every column is populated or explicitly unknown.** A blank cell and a zero mean different
 * things, and a portfolio that renders "0 criticals" for a project nothing has ever been ingested
 * for is worse than one that says it does not know: the first is a wrong answer delivered
 * confidently.
 */

export interface PortfolioRow {
  readonly code: string;
  readonly name: string;
  readonly lifecycle: string;
  readonly phase: { readonly humanId: string; readonly number: string; readonly name: string } | null;
  readonly tasks: { readonly open: number; readonly blocked: number; readonly done: number };
  readonly openCriticals: number;
  readonly ci: { readonly conclusion: string | null; readonly unknown: boolean };
  readonly drift: {
    readonly uncoveredRequirements: number;
    readonly unconfirmedAttributions: number;
    /** The badge (FRM-REQ-127). The same engine the drift screen reads, so they cannot disagree. */
    readonly total: number;
  };
  readonly lastActivityAt: string | null;
}

export async function portfolio(db: Db, codes?: string[]): Promise<PortfolioRow[]> {
  const projects = await db.project.findMany({
    where: { deletedAt: null, ...(codes === undefined ? {} : { code: { in: codes } }) },
    orderBy: { code: 'asc' },
  });

  // One round trip per project is acceptable at this scale — there are twenty of them, not twenty
  // thousand — and it keeps each column's meaning legible. If that ever changes, this is one query.
  return Promise.all(
    projects.map(async (project): Promise<PortfolioRow> => {
      const [phase, open, blocked, done, criticals, check, uncovered, unconfirmed, lastCommit] =
        await Promise.all([
          db.phase.findFirst({
            where: { projectId: project.id, status: 'active', deletedAt: null },
            orderBy: { sortOrder: 'asc' },
            select: { humanId: true, number: true, name: true },
          }),
          db.task.count({
            where: {
              projectId: project.id,
              deletedAt: null,
              status: { in: ['todo', 'in_progress'] },
            },
          }),
          db.task.count({ where: { projectId: project.id, deletedAt: null, status: 'blocked' } }),
          db.task.count({ where: { projectId: project.id, deletedAt: null, status: 'done' } }),
          db.finding.count({
            where: {
              projectId: project.id,
              deletedAt: null,
              status: 'open',
              severity: { in: ['critical', 'high'] },
            },
          }),
          db.checkRun.findFirst({
            where: { repo: { projectId: project.id }, completedAt: { not: null } },
            orderBy: { completedAt: 'desc' },
            select: { conclusion: true },
          }),
          db.requirement.count({
            where: { projectId: project.id, deletedAt: null, tasks: { none: {} } },
          }),
          // Unconfirmed only — a proposal is not progress (ADR-005).
          db.commitTask.count({
            where: {
              confirmed: false,
              rejectedAt: null,
              task: { projectId: project.id, deletedAt: null },
            },
          }),
          db.commit.findFirst({
            where: { repo: { projectId: project.id } },
            orderBy: { committedAt: 'desc' },
            select: { committedAt: true },
          }),
        ]);

      return {
        code: project.code,
        name: project.name,
        lifecycle: project.lifecycle,
        phase:
          phase === null
            ? null
            : { humanId: phase.humanId, number: phase.number.toString(), name: phase.name },
        tasks: { open, blocked, done },
        openCriticals: criticals,
        ci: {
          conclusion: check?.conclusion ?? null,
          // Grey, not green: never ingested is not the same as passing.
          unknown: check === null,
        },
        drift: {
          uncoveredRequirements: uncovered,
          unconfirmedAttributions: unconfirmed,
          total: (await driftFor(db, project.code)).total,
        },
        lastActivityAt: lastCommit?.committedAt.toISOString() ?? null,
      };
    }),
  );
}
