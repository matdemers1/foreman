import {
  formatProjectIdeaId,
  PROJECT_IDEA_NEEDS_REASON,
  type ProjectIdeaConvert,
  type ProjectIdeaCreate,
  type ProjectIdeaStatus,
  type ProjectIdeaUpdate,
} from '@foreman/shared';
import type { Db } from '../db.js';
import { record, type Actor, type TransactionClient } from './audit.js';
import { Conflict, Invalid, NotFound } from './errors.js';
import { createProject } from './projects.js';

/**
 * Project ideas — something that might become a project, before it is one
 * (FRM-REQ-159 … FRM-REQ-164, FRM-ADR-015).
 *
 * The one record in Foreman that belongs to no project. Everything else here is filed under a
 * code, and a project idea is precisely the thing that does not have one yet — which is the whole
 * reason it is a separate table rather than an `Idea` with a nullable parent. A nullable parent
 * would have made every query, every ID, and every route in the ideas feature answer "it depends".
 *
 * **The code is asked for at conversion, not at capture.** A project code is immutable and
 * embedded in every human ID the project will ever have (ADR-008). Demanding one to write down
 * "maybe a fuel tracker someday" asks a permanent question at the moment there is least
 * information to answer it, and the answer is then wrong forever. `PI-007` costs nothing and
 * carries no decision.
 */

const SELECT = {
  id: true,
  humanId: true,
  seq: true,
  title: true,
  pitch: true,
  status: true,
  reason: true,
  decidedAt: true,
  convertedAt: true,
  createdAt: true,
  updatedAt: true,
  project: { select: { code: true, name: true, lifecycle: true } },
} as const;

/**
 * The next `PI-` number, from a Postgres sequence.
 *
 * Not from a counter column, because there is no project row to hold one and no project row to
 * lock. `nextval` is atomic under concurrency and — the property that matters for a human ID —
 * **never hands back a number it has already given**, even when the transaction that took it
 * rolls back. A gap in the sequence is correct; a reused number would make every citation of the
 * old `PI-007` point at a different idea.
 */
async function nextSeq(tx: TransactionClient): Promise<number> {
  const rows = await tx.$queryRaw<{ seq: number }[]>`
    select nextval('project_idea_seq')::int as seq
  `;
  const seq = rows[0]?.seq;
  if (seq === undefined) throw new Error('project_idea_seq did not yield a value');
  return seq;
}

export async function allProjectIdeas(db: Db, status?: ProjectIdeaStatus) {
  return db.projectIdea.findMany({
    where: { deletedAt: null, ...(status === undefined ? {} : { status }) },
    // Untriaged first — the list exists to be worked through — then newest. `converted` sorts
    // last of the five, which is right: it is the only status that is finished rather than open.
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    select: SELECT,
  });
}

export async function findProjectIdea(db: Db, humanId: string) {
  const idea = await db.projectIdea.findFirst({
    where: { humanId, deletedAt: null },
    select: SELECT,
  });
  if (idea === null) throw new NotFound(humanId);
  return idea;
}

export async function createProjectIdea(db: Db, actor: Actor, input: ProjectIdeaCreate) {
  return db.$transaction(async (tx) => {
    const seq = await nextSeq(tx);
    const idea = await tx.projectIdea.create({
      data: {
        humanId: formatProjectIdeaId(seq),
        seq,
        title: input.title,
        ...(input.pitch === undefined ? {} : { pitch: input.pitch }),
      },
      select: SELECT,
    });

    await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'project_idea',
      entityId: idea.id,
      entityHumanId: idea.humanId,
      after: idea,
    });
    return idea;
  });
}

export async function updateProjectIdea(
  db: Db,
  actor: Actor,
  humanId: string,
  input: ProjectIdeaUpdate,
) {
  const before = await db.projectIdea.findFirst({ where: { humanId, deletedAt: null } });
  if (before === null) throw new NotFound(humanId);

  // A converted idea is a historical record of how a project started. Editing its title or
  // reopening it would leave the project it names pointing at something that no longer says it.
  if (before.status === 'converted') {
    throw new Conflict(
      `${humanId} became a project and cannot be changed — edit the project instead`,
    );
  }

  // Against the merged state, not the patch: a request that sets only the status would otherwise
  // pass while leaving the previous reason — or none — attached to a new decision.
  const status = input.status ?? before.status;
  const reason = input.reason === undefined ? before.reason : input.reason;
  if (
    PROJECT_IDEA_NEEDS_REASON.includes(status) &&
    (reason === null || reason.trim().length === 0)
  ) {
    throw new Invalid(`a project idea that is ${status} must say why`, [
      { path: 'reason', message: `required when the status is ${status}` },
    ]);
  }

  return db.$transaction(async (tx) => {
    const idea = await tx.projectIdea.update({
      where: { id: before.id },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.pitch === undefined ? {} : { pitch: input.pitch }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.reason === undefined ? {} : { reason: input.reason ?? null }),
        ...(input.status === undefined
          ? {}
          : { decidedAt: input.status === 'new' ? null : (before.decidedAt ?? new Date()) }),
        // Back to `new` un-decides it, and retires the reason it carried — "deliberately not now"
        // must not linger on an idea nobody has judged.
        ...(input.status === 'new' && input.reason === undefined ? { reason: null } : {}),
      },
      select: SELECT,
    });

    await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'project_idea',
      entityId: idea.id,
      entityHumanId: humanId,
      before,
      after: idea,
    });
    return idea;
  });
}

/**
 * Turn an idea into a project (FRM-REQ-162).
 *
 * The idea is **kept**, not consumed. It becomes the record of where the project came from and
 * what it was for before anybody had built any of it — which is the one piece of a project's
 * history that is otherwise never written down anywhere.
 */
export async function convertProjectIdea(
  db: Db,
  actor: Actor,
  humanId: string,
  input: ProjectIdeaConvert,
) {
  const before = await db.projectIdea.findFirst({ where: { humanId, deletedAt: null } });
  if (before === null) throw new NotFound(humanId);
  if (before.status === 'converted') {
    throw new Conflict(`${humanId} has already been converted`);
  }

  // Created first, and outside the update: `createProject` refuses a code already in use, and a
  // refusal has to leave the idea exactly as it was rather than half-converted.
  const project = await createProject(db, actor, {
    code: input.code,
    name: input.name ?? before.title,
    ...(before.pitch === null ? {} : { pitch: before.pitch }),
    ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
  });

  const idea = await db.$transaction(async (tx) => {
    const converted = await tx.projectIdea.update({
      where: { id: before.id },
      data: {
        status: 'converted',
        projectId: project.id,
        convertedAt: new Date(),
        decidedAt: before.decidedAt ?? new Date(),
      },
      select: SELECT,
    });

    await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'project_idea',
      entityId: converted.id,
      entityHumanId: humanId,
      before,
      after: converted,
    });
    return converted;
  });

  return { idea, project };
}
