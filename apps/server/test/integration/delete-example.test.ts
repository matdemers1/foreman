import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db.js';

/**
 * Deleting the example project (FRM-REQ-015, T-10.10).
 *
 * The acceptance test the requirement carries is "command removes every row; no orphan references
 * remain", so that is what this asserts — not that the project is gone, which is the easy half.
 *
 * This is the one hard delete in Foreman. Everywhere else a row is soft-deleted, because an ID must
 * never be reused and an undo must always be possible. The example project is seeded, was never
 * real, and its codes have to be free for the next seed to take back.
 */

const url = process.env['DATABASE_URL'];
const CODE = 'XMPL';

describe.skipIf(url === undefined)('deleting an example project', () => {
  let db: Db;

  beforeAll(() => {
    db = createDb(url ?? '');
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.$disconnect();
  });

  it('takes every row under it, leaving no orphans', async () => {
    const project = await db.project.create({
      data: { code: CODE, name: 'Throwaway', slug: 'throwaway', lifecycle: 'building' },
    });
    const phase = await db.phase.create({
      data: { projectId: project.id, humanId: `${CODE}-P-1`, number: '1', sortOrder: 1, name: 'One' },
    });
    await db.requirement.create({
      data: { projectId: project.id, humanId: `${CODE}-REQ-001`, seq: 1, statement: 'A thing', priority: 'M' },
    });
    await db.task.create({
      data: { projectId: project.id, phaseId: phase.id, humanId: `${CODE}-T-1.1`, title: 'Do it' },
    });

    // The delete itself is what the CLI performs; the cascade is the property under test.
    await db.project.delete({ where: { id: project.id } });

    const orphans = await db.$queryRaw<{ rows: bigint }[]>`
      select count(*) as rows from (
        select r.id from requirement r where not exists (select 1 from project p where p.id = r.project_id)
        union all
        select t.id from task t where not exists (select 1 from project p where p.id = t.project_id)
        union all
        select ph.id from phase ph where not exists (select 1 from project p where p.id = ph.project_id)
      ) o
    `;
    expect(Number(orphans[0]?.rows ?? 0)).toBe(0);
    expect(await db.project.findFirst({ where: { code: CODE } })).toBeNull();
  });

  it('frees the code, so a later example seed can take it back', async () => {
    // A soft delete would leave the code occupied and the next seed would collide. This is why the
    // one exception to soft-delete exists.
    const first = await db.project.create({
      data: { code: CODE, name: 'First', slug: 'first', lifecycle: 'building' },
    });
    await db.project.delete({ where: { id: first.id } });

    const second = await db.project.create({
      data: { code: CODE, name: 'Second', slug: 'second', lifecycle: 'building' },
    });
    expect(second.code).toBe(CODE);
    await db.project.delete({ where: { id: second.id } });
  });
});
