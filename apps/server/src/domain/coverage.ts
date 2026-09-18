import type { Db } from '../db.js';
import { Conflict, NotFound } from './errors.js';

/**
 * Coverage and the exit gate (T-3.4, T-3.6 — FRM-REQ-053, FRM-REQ-054, FRM-REQ-056).
 *
 * This is where the hand-maintained traceability matrix dies. Nobody updates a matrix in a document
 * after the third week; a query cannot forget.
 *
 * **Coverage counts only confirmed attributions** (ADR-005). A requirement is not covered because a
 * commit happened to touch a file a task declared — that is a coincidence, and letting a
 * coincidence close a phase is how a ledger stops being worth reading.
 */

export interface CoverageHole {
  readonly humanId: string;
  readonly statement: string;
  readonly priority: string;
  readonly reason: 'uncovered' | 'no-acceptance-test' | 'covered-by-unfinished-work';
}

export interface Coverage {
  readonly project: string;
  readonly requirements: {
    readonly total: number;
    readonly covered: number;
    readonly musts: number;
    readonly mustsCovered: number;
  };
  /** Musts with no task citing them. The number that decides whether a phase can close. */
  readonly uncoveredMusts: readonly CoverageHole[];
  /** Any priority, uncovered. Worth seeing, but not blocking. */
  readonly uncovered: readonly CoverageHole[];
  /** Requirements nothing can be checked against, which is a different kind of hole. */
  readonly withoutAcceptanceTest: readonly CoverageHole[];
  /** Work with no stated reason — the coverage hole seen from the other side. */
  readonly tasksWithoutRequirements: readonly { humanId: string; title: string }[];
  /** Statements the lint could not read as a behaviour. */
  readonly earsWarnings: readonly { humanId: string; statement: string; note: string }[];
}

const MUST = 'M';

export async function coverageFor(db: Db, code: string): Promise<Coverage> {
  const project = await db.project.findFirst({ where: { code, deletedAt: null } });
  if (project === null) throw new NotFound(`project ${code}`);

  const requirements = await db.requirement.findMany({
    where: { projectId: project.id, deletedAt: null },
    orderBy: { seq: 'asc' },
    include: {
      tasks: {
        select: { task: { select: { humanId: true, status: true, deletedAt: true } } },
      },
    },
  });

  const hole = (r: (typeof requirements)[number], reason: CoverageHole['reason']): CoverageHole => ({
    humanId: r.humanId,
    statement: r.statement,
    priority: r.priority,
    reason,
  });

  const uncovered: CoverageHole[] = [];
  const uncoveredMusts: CoverageHole[] = [];
  const withoutAcceptanceTest: CoverageHole[] = [];
  const earsWarnings: { humanId: string; statement: string; note: string }[] = [];
  let covered = 0;
  let musts = 0;
  let mustsCovered = 0;

  for (const requirement of requirements) {
    // A soft-deleted task covers nothing.
    const citing = requirement.tasks.filter((t) => t.task.deletedAt === null);
    const isCovered = citing.length > 0;
    const isMust = requirement.priority === MUST;

    if (isCovered) covered += 1;
    if (isMust) musts += 1;
    if (isMust && isCovered) mustsCovered += 1;

    if (!isCovered) {
      uncovered.push(hole(requirement, 'uncovered'));
      if (isMust) uncoveredMusts.push(hole(requirement, 'uncovered'));
    }

    if (requirement.acceptanceTest === null || requirement.acceptanceTest.trim() === '') {
      withoutAcceptanceTest.push(hole(requirement, 'no-acceptance-test'));
    }

    if (!requirement.earsLintOk && requirement.earsLintNote !== null) {
      earsWarnings.push({
        humanId: requirement.humanId,
        statement: requirement.statement,
        note: requirement.earsLintNote,
      });
    }
  }

  const orphanTasks = await db.task.findMany({
    where: {
      projectId: project.id,
      deletedAt: null,
      requirements: { none: {} },
      // A cancelled task needs no reason: it was abandoned, which is itself the reason.
      status: { not: 'cancelled' },
    },
    orderBy: { humanId: 'asc' },
    select: { humanId: true, title: true },
  });

  return {
    project: project.code,
    requirements: { total: requirements.length, covered, musts, mustsCovered },
    uncoveredMusts,
    uncovered,
    withoutAcceptanceTest,
    tasksWithoutRequirements: orphanTasks,
    earsWarnings,
  };
}

// ─── The exit gate ─────────────────────────────────────────────────────────

export interface GateFailure {
  readonly kind: 'uncovered-must' | 'unfinished-task' | 'open-critical';
  readonly humanId: string;
  readonly detail: string;
}

export interface GateResult {
  readonly phase: string;
  readonly passed: boolean;
  /** Each failure names the thing that failed — never "the gate failed". */
  readonly failures: readonly GateFailure[];
}

/**
 * Can this phase be called complete?
 *
 * **Every failure names the requirement, task or finding responsible** (FRM-REQ-056). "The exit gate
 * failed" tells somebody to go looking; naming the three Musts with no task tells them what to do.
 */
export async function exitGate(db: Db, phaseHumanId: string): Promise<GateResult> {
  const phase = await db.phase.findFirst({
    where: { humanId: phaseHumanId, deletedAt: null },
    include: { project: { select: { id: true, code: true } } },
  });
  if (phase === null) throw new NotFound(phaseHumanId);

  const failures: GateFailure[] = [];

  // 1. Musts assigned to this phase that no task covers.
  const musts = await db.requirement.findMany({
    where: { phaseId: phase.id, deletedAt: null, priority: MUST },
    include: { tasks: { select: { task: { select: { deletedAt: true } } } } },
  });
  for (const must of musts) {
    if (must.tasks.filter((t) => t.task.deletedAt === null).length === 0) {
      failures.push({
        kind: 'uncovered-must',
        humanId: must.humanId,
        detail: `no task satisfies it — ${must.statement.slice(0, 90)}`,
      });
    }
  }

  // 2. Work in the phase that is neither done nor deliberately abandoned.
  const unfinished = await db.task.findMany({
    where: {
      phaseId: phase.id,
      deletedAt: null,
      status: { in: ['todo', 'in_progress', 'blocked'] },
    },
    orderBy: { humanId: 'asc' },
    select: { humanId: true, title: true, status: true, blockedReason: true },
  });
  for (const task of unfinished) {
    failures.push({
      kind: 'unfinished-task',
      humanId: task.humanId,
      detail:
        task.status === 'blocked'
          ? `blocked — ${task.blockedReason ?? 'no reason recorded'}`
          : `${task.status} — ${task.title}`,
    });
  }

  // 3. Criticals found during this phase and still open.
  const criticals = await db.finding.findMany({
    where: {
      phaseId: phase.id,
      deletedAt: null,
      status: 'open',
      severity: { in: ['critical', 'high'] },
    },
    orderBy: { humanId: 'asc' },
    select: { humanId: true, title: true, severity: true },
  });
  for (const finding of criticals) {
    failures.push({
      kind: 'open-critical',
      humanId: finding.humanId,
      detail: `${finding.severity} and still open — ${finding.title}`,
    });
  }

  return { phase: phaseHumanId, passed: failures.length === 0, failures };
}

/** Thrown when a phase is asked to complete and the gate says no. Carries every reason. */
export class GateRefused extends Conflict {
  constructor(readonly result: GateResult) {
    super(
      `${result.phase} cannot be completed: ${String(result.failures.length)} ` +
        `${result.failures.length === 1 ? 'thing is' : 'things are'} in the way`,
    );
    this.name = 'GateRefused';
  }
}

/**
 * The traceability matrix (T-3.5, FRM-REQ-055) — generated, never maintained.
 *
 * One row per requirement, the tasks that satisfy it, and the phase it belongs to. This is the
 * document that used to be kept by hand and was wrong within a fortnight.
 */
export async function traceabilityMatrix(db: Db, code: string) {
  const project = await db.project.findFirst({ where: { code, deletedAt: null } });
  if (project === null) throw new NotFound(`project ${code}`);

  const requirements = await db.requirement.findMany({
    where: { projectId: project.id, deletedAt: null },
    orderBy: { seq: 'asc' },
    include: {
      phase: { select: { humanId: true, number: true, name: true } },
      tasks: {
        select: {
          task: { select: { humanId: true, title: true, status: true, deletedAt: true } },
        },
      },
    },
  });

  return requirements.map((requirement) => ({
    humanId: requirement.humanId,
    statement: requirement.statement,
    priority: requirement.priority,
    earsPattern: requirement.earsPattern,
    earsLintOk: requirement.earsLintOk,
    acceptanceTest: requirement.acceptanceTest,
    phase:
      requirement.phase === null
        ? null
        : {
            humanId: requirement.phase.humanId,
            number: requirement.phase.number.toString(),
            name: requirement.phase.name,
          },
    satisfiedBy: requirement.tasks
      .filter((t) => t.task.deletedAt === null)
      .map((t) => ({ humanId: t.task.humanId, title: t.task.title, status: t.task.status })),
  }));
}
