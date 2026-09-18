import type { Db } from '../db.js';
import { NotFound } from './errors.js';

/**
 * The session brief (FRM-REQ-082, FRM-REQ-083, FRM-REQ-092) — the most-used path in the system.
 *
 * It replaces what `/start-development` does by reading a dozen files: one call, a few hundred
 * tokens, and work begins from accurate state rather than from a multi-file read.
 *
 * Two rules shape everything here:
 *
 * 1. **A blocked task never appears among the next tasks.** "What should I work on" that answers
 *    with something you cannot work on is worse than no answer, because it costs the reader the
 *    time to find out.
 * 2. **An unconfirmed attribution is never truth** (ADR-005). Nothing below counts a
 *    `commit_task` row with `confirmed = false`: a file-path coincidence must never make work look
 *    complete, and the brief is exactly where that lie would be believed.
 */

/** What the brief will return at most, per list. The budget is the feature, not a limitation. */
const NEXT_TASKS = 5;
const CRITICAL_FINDINGS = 5;
const RECENT_COMMITS = 3;

export interface Brief {
  readonly project: {
    readonly code: string;
    readonly name: string;
    readonly lifecycle: string;
    readonly pitch: string | null;
  };
  readonly activePhase: {
    readonly humanId: string;
    readonly number: string;
    readonly name: string;
    readonly objective: string | null;
    readonly exitDemo: string | null;
    readonly tasks: { readonly done: number; readonly total: number };
  } | null;
  /** Ready to pick up: never blocked, never done. */
  readonly nextTasks: readonly {
    readonly humanId: string;
    readonly title: string;
    readonly status: string;
    readonly size: string | null;
    readonly doneWhen: string | null;
    readonly requirements: readonly string[];
  }[];
  /** Named separately, because a blocked task is a thing to unblock, not a thing to do. */
  readonly blocked: readonly {
    readonly humanId: string;
    readonly title: string;
    readonly reason: string | null;
  }[];
  readonly openCriticals: readonly {
    readonly humanId: string;
    readonly severity: string;
    readonly title: string;
    readonly location: string | null;
  }[];
  readonly ci: {
    readonly conclusion: string | null;
    readonly commitSha: string | null;
    readonly at: string | null;
    /** True when nothing has been ingested — "unknown" is an honest answer, not a failure. */
    readonly unknown: boolean;
  };
  readonly drift: {
    /** Requirements no task covers. The register's whole purpose. */
    readonly uncoveredRequirements: number;
    /** Attributions waiting to be confirmed or rejected. Proposals, not facts. */
    readonly unconfirmedAttributions: number;
    /** Risks whose tripwire has fired. */
    readonly firedRisks: number;
  };
  readonly recentCommits: readonly {
    readonly sha: string;
    readonly message: string;
    readonly at: string;
  }[];
}

export async function buildBrief(db: Db, code: string): Promise<Brief> {
  const project = await db.project.findFirst({ where: { code, deletedAt: null } });
  if (project === null) throw new NotFound(`project ${code}`);

  // The active phase, or the furthest along one if none is marked active — a project mid-flight
  // always has a "where are we", even when nobody remembered to set a status.
  const activePhase =
    (await db.phase.findFirst({
      where: { projectId: project.id, status: 'active', deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    })) ??
    (await db.phase.findFirst({
      where: { projectId: project.id, status: 'planned', deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    }));

  const [nextTasks, blocked, criticals, latestCheck, uncovered, unconfirmed, firedRisks, commits] =
    await Promise.all([
      db.task.findMany({
        where: {
          projectId: project.id,
          deletedAt: null,
          // Never blocked. This is the requirement, expressed where it is enforced.
          status: { in: ['todo', 'in_progress'] },
          ...(activePhase === null ? {} : { phaseId: activePhase.id }),
        },
        orderBy: [{ status: 'desc' }, { sortOrder: 'asc' }],
        take: NEXT_TASKS,
        include: { requirements: { select: { requirement: { select: { humanId: true } } } } },
      }),
      db.task.findMany({
        where: { projectId: project.id, deletedAt: null, status: 'blocked' },
        orderBy: { sortOrder: 'asc' },
        take: NEXT_TASKS,
        select: { humanId: true, title: true, blockedReason: true },
      }),
      db.finding.findMany({
        where: {
          projectId: project.id,
          deletedAt: null,
          status: 'open',
          severity: { in: ['critical', 'high'] },
        },
        orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
        take: CRITICAL_FINDINGS,
        select: {
          humanId: true,
          severity: true,
          title: true,
          locationPath: true,
          locationLines: true,
        },
      }),
      db.checkRun.findFirst({
        where: { repo: { projectId: project.id }, completedAt: { not: null } },
        orderBy: { completedAt: 'desc' },
        select: { conclusion: true, commitSha: true, completedAt: true },
      }),
      db.requirement.count({
        where: { projectId: project.id, deletedAt: null, tasks: { none: {} } },
      }),
      db.commitTask.count({
        where: {
          confirmed: false,
          rejectedAt: null,
          task: { projectId: project.id, deletedAt: null },
        },
      }),
      db.risk.count({ where: { projectId: project.id, deletedAt: null, status: 'fired' } }),
      db.commit.findMany({
        where: { repo: { projectId: project.id } },
        orderBy: { committedAt: 'desc' },
        take: RECENT_COMMITS,
        select: { sha: true, message: true, committedAt: true },
      }),
    ]);

  const phaseTasks =
    activePhase === null
      ? { done: 0, total: 0 }
      : {
          done: await db.task.count({
            where: { phaseId: activePhase.id, status: 'done', deletedAt: null },
          }),
          total: await db.task.count({ where: { phaseId: activePhase.id, deletedAt: null } }),
        };

  return {
    project: {
      code: project.code,
      name: project.name,
      lifecycle: project.lifecycle,
      pitch: project.pitch,
    },
    activePhase:
      activePhase === null
        ? null
        : {
            humanId: activePhase.humanId,
            number: activePhase.number.toString(),
            name: activePhase.name,
            objective: activePhase.objective,
            exitDemo: activePhase.exitDemo,
            tasks: phaseTasks,
          },
    nextTasks: nextTasks.map((task) => ({
      humanId: task.humanId,
      title: task.title,
      status: task.status,
      size: task.size,
      doneWhen: task.doneWhen,
      requirements: task.requirements.map((r) => r.requirement.humanId),
    })),
    blocked: blocked.map((task) => ({
      humanId: task.humanId,
      title: task.title,
      reason: task.blockedReason,
    })),
    openCriticals: criticals.map((finding) => ({
      humanId: finding.humanId,
      severity: finding.severity,
      title: finding.title,
      location:
        finding.locationPath === null
          ? null
          : `${finding.locationPath}${finding.locationLines === null ? '' : `:${finding.locationLines}`}`,
    })),
    ci: {
      conclusion: latestCheck?.conclusion ?? null,
      commitSha: latestCheck?.commitSha ?? null,
      at: latestCheck?.completedAt?.toISOString() ?? null,
      // Grey, not red: nothing ingested is not the same as a failing build.
      unknown: latestCheck === null,
    },
    drift: {
      uncoveredRequirements: uncovered,
      unconfirmedAttributions: unconfirmed,
      firedRisks,
    },
    recentCommits: commits.map((commit) => ({
      sha: commit.sha.slice(0, 7),
      message: commit.message.split('\n')[0] ?? '',
      at: commit.committedAt.toISOString(),
    })),
  };
}

/**
 * A rough token count for the brief, used by the test that keeps it inside its budget.
 *
 * Four characters per token is the usual approximation for English JSON, and it is deliberately
 * crude: the point is to notice a brief that has doubled, not to bill anybody for it.
 */
export function approximateTokens(payload: unknown): number {
  return Math.ceil(JSON.stringify(payload).length / 4);
}

/** The ceiling. A brief that costs more than this has stopped being a brief. */
export const BRIEF_TOKEN_BUDGET = 900;
