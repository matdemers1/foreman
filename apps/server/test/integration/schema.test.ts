import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db.js';

/**
 * The schema's three expensive-to-fix decisions, asserted against a real database (T-0.3).
 *
 * Each of these is cheap to get right now and costs a migration plus a data rewrite later, which is
 * exactly why they are pinned by a test rather than by a comment.
 */

const url = process.env['DATABASE_URL'];

describe.skipIf(url === undefined)('schema invariants', () => {
  let db: Db;
  let projectId: string;

  beforeAll(async () => {
    db = createDb(url ?? '');
    // Cascades clear anything a previous failed run left behind, so the suite is re-runnable.
    await db.project.deleteMany({ where: { code: 'TST' } });
    const project = await db.project.create({
      data: { code: 'TST', name: 'Schema test', slug: 'schema-test' },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: 'TST' } });
    await db.$disconnect();
  });

  it('stores a decimal phase number, because Bindery shipped a Phase 8.5', async () => {
    const phase = await db.phase.create({
      data: {
        projectId,
        number: 8.5,
        sortOrder: 10,
        humanId: 'TST-P-8.5',
        name: 'The one that proves numeric',
      },
    });
    expect(phase.number.toString()).toBe('8.5');
  });

  it('orders phases independently of their numbers', async () => {
    // Bindery built 0–8.5, then 9–11, then 13–16, with 12 still ahead: build order is not numbering.
    await db.phase.createMany({
      data: [
        { projectId, number: 13, sortOrder: 20, humanId: 'TST-P-13', name: 'Built fourth' },
        { projectId, number: 12, sortOrder: 99, humanId: 'TST-P-12', name: 'Still ahead' },
      ],
    });
    const byBuildOrder = await db.phase.findMany({
      where: { projectId },
      orderBy: { sortOrder: 'asc' },
      select: { humanId: true },
    });
    expect(byBuildOrder.map((p) => p.humanId)).toEqual(['TST-P-8.5', 'TST-P-13', 'TST-P-12']);
  });

  it('accepts a requirement with no phase — an unassigned requirement is the backlog', async () => {
    const req = await db.requirement.create({
      data: {
        projectId,
        humanId: 'TST-REQ-001',
        seq: 1,
        statement: 'Foreman shall keep a backlog.',
      },
    });
    expect(req.phaseId).toBeNull();
  });

  it('keeps an unparsed requirement rather than rejecting it', async () => {
    const req = await db.requirement.create({
      data: {
        projectId,
        humanId: 'TST-REQ-002',
        seq: 2,
        statement: 'This sentence is not EARS at all.',
        earsPattern: 'unparsed',
        earsLintOk: false,
        earsLintNote: 'no EARS keyword found',
      },
    });
    expect(req.earsPattern).toBe('unparsed');
    expect(req.earsLintOk).toBe(false);
  });

  it('relates tasks and requirements many-to-many in both directions', async () => {
    const [reqA, reqB] = await Promise.all([
      db.requirement.create({
        data: { projectId, humanId: 'TST-REQ-003', seq: 3, statement: 'A.' },
      }),
      db.requirement.create({
        data: { projectId, humanId: 'TST-REQ-004', seq: 4, statement: 'B.' },
      }),
    ]);
    const task = await db.task.create({
      data: {
        projectId,
        humanId: 'TST-T-0.1',
        title: 'Satisfies two requirements',
        requirements: { create: [{ requirementId: reqA.id }, { requirementId: reqB.id }] },
      },
      include: { requirements: true },
    });
    expect(task.requirements).toHaveLength(2);

    const second = await db.task.create({
      data: {
        projectId,
        humanId: 'TST-T-0.2',
        title: 'Also covers A',
        requirements: { create: [{ requirementId: reqA.id }] },
      },
    });
    const coveringA = await db.taskRequirement.findMany({ where: { requirementId: reqA.id } });
    expect(coveringA.map((t) => t.taskId).sort()).toEqual([task.id, second.id].sort());
  });

  it('refuses a duplicate human ID, because citations must resolve to one thing', async () => {
    await expect(
      db.requirement.create({
        data: { projectId, humanId: 'TST-REQ-001', seq: 99, statement: 'Duplicate.' },
      }),
    ).rejects.toThrow();
  });

  it('defaults an attribution to unconfirmed — a proposal is not a fact', async () => {
    const repo = await db.repo.create({ data: { projectId, fullName: 'test/schema-test' } });
    const commit = await db.commit.create({
      data: {
        repoId: repo.id,
        sha: 'a'.repeat(40),
        message: 'Touches a declared path',
        author: 'tester',
        committedAt: new Date(),
      },
    });
    const task = await db.task.findFirstOrThrow({ where: { humanId: 'TST-T-0.1' } });
    const link = await db.commitTask.create({
      data: { commitId: commit.id, taskId: task.id, source: 'file_overlap', confidence: 0.4 },
    });
    expect(link.confirmed).toBe(false);
    expect(link.confidence.toString()).toBe('0.4');
  });
});
