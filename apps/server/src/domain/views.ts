import type { Db } from '../db.js';
import { NotFound } from './errors.js';

/**
 * The generated registers (T-3.9 — FRM-REQ-057, FRM-REQ-074, ADR-006).
 *
 * The Scope of Work and the Requirements Register were documents. Both went stale the week they
 * were written, because a document is a copy and a copy has to be maintained by somebody who
 * remembers. Here they are **queries** — there is no `scope_of_work` or `requirements_register`
 * document kind to author, and the `DocumentKind` enum is where that is actually enforced.
 *
 * The register view itself lives in `coverage.ts` as the traceability matrix; this is its other
 * half, the plan seen from the phases down.
 */

export interface ScopeOfWorkTask {
  readonly humanId: string;
  readonly title: string;
  readonly status: string;
  readonly size: string | null;
  readonly blockedReason: string | null;
  readonly doneWhen: string | null;
  /** The requirement IDs this task cites — the citations the authored document kept by hand. */
  readonly satisfies: readonly string[];
}

export interface ScopeOfWorkPhase {
  readonly humanId: string;
  readonly number: string;
  readonly name: string;
  readonly objective: string | null;
  readonly status: string;
  readonly exitDemo: string | null;
  readonly size: string | null;
  readonly tasks: readonly ScopeOfWorkTask[];
  readonly done: number;
  /** Musts assigned to this phase that no live task cites. What the exit gate will refuse over. */
  readonly uncoveredMusts: readonly string[];
}

export interface ScopeOfWork {
  readonly project: { readonly code: string; readonly name: string };
  readonly phases: readonly ScopeOfWorkPhase[];
  /** Work belonging to no phase. Not an error: it is the part of the plan nobody has placed yet. */
  readonly unphased: readonly ScopeOfWorkTask[];
  readonly generatedAt: string;
}

export async function scopeOfWork(db: Db, code: string): Promise<ScopeOfWork> {
  const project = await db.project.findFirst({ where: { code, deletedAt: null } });
  if (project === null) throw new NotFound(`project ${code}`);

  const [phases, tasks, musts] = await Promise.all([
    db.phase.findMany({
      where: { projectId: project.id, deletedAt: null },
      // Build order, not numeric order: Bindery built 0–8.5, then 9–11, then 13–16, with 12 ahead.
      orderBy: { sortOrder: 'asc' },
    }),
    db.task.findMany({
      where: { projectId: project.id, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { humanId: 'asc' }],
      include: {
        requirements: { select: { requirement: { select: { humanId: true } } } },
      },
    }),
    db.requirement.findMany({
      where: { projectId: project.id, deletedAt: null, priority: 'M' },
      select: {
        humanId: true,
        phaseId: true,
        tasks: { where: { task: { deletedAt: null } }, select: { taskId: true } },
      },
    }),
  ]);

  const shape = (task: (typeof tasks)[number]): ScopeOfWorkTask => ({
    humanId: task.humanId,
    title: task.title,
    status: task.status,
    size: task.size,
    blockedReason: task.blockedReason,
    doneWhen: task.doneWhen,
    satisfies: task.requirements.map((r) => r.requirement.humanId),
  });

  return {
    project: { code: project.code, name: project.name },
    phases: phases.map((phase) => {
      const mine = tasks.filter((task) => task.phaseId === phase.id);
      return {
        humanId: phase.humanId,
        number: phase.number.toString(),
        name: phase.name,
        objective: phase.objective,
        status: phase.status,
        exitDemo: phase.exitDemo,
        size: phase.size,
        tasks: mine.map(shape),
        done: mine.filter((task) => task.status === 'done').length,
        uncoveredMusts: musts
          .filter((must) => must.phaseId === phase.id && must.tasks.length === 0)
          .map((must) => must.humanId),
      };
    }),
    unphased: tasks.filter((task) => task.phaseId === null).map(shape),
    // Stamped, because the whole claim of a generated view is that it is current as of now.
    generatedAt: new Date().toISOString(),
  };
}
