import { loadConfig } from '../config.js';
import { createDb } from '../db.js';

/**
 * Delete the example project and every row under it (FRM-REQ-015, T-10.10).
 *
 *   docker compose exec -T server node dist/cli/delete-example.js --confirm
 *
 * The example project is what development runs against, and the cutover is the moment it stops
 * being useful — the real corpus is in, so a disposable `EXMP` alongside it is a second answer to
 * "what projects are there". It is deleted last, deliberately: right up until this runs it is the
 * fallback, the one project you can break without consequence.
 *
 * **A hard delete, not the soft delete everything else uses.** Foreman never truly removes a row,
 * because a deleted requirement's ID must never be reused and an undo must always be possible. The
 * example project is the single exception: it was seeded, it was never real, and leaving it
 * soft-deleted would leave its IDs occupying a code that a future example seed wants back.
 */

const CODES = ['EXMP', 'NBR'] as const;

if (!process.argv.includes('--confirm')) {
  process.stderr.write(
    'usage: delete-example --confirm\n\n' +
      `  Permanently removes the example projects (${CODES.join(', ')}) and every row under them.\n` +
      '  This is not the soft delete used everywhere else: there is no undo.\n',
  );
  process.exit(1);
}

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

try {
  const projects = await db.project.findMany({
    where: { code: { in: [...CODES] } },
    select: { id: true, code: true, name: true },
  });

  if (projects.length === 0) {
    process.stdout.write('nothing to delete: no example project is present\n');
  }

  for (const project of projects) {
    // Counted before the delete, so the report says what actually went rather than what was asked
    // for. Cascades take phases, tasks, requirements, documents, findings and audits with it.
    const [requirements, tasks, findings, documents] = await Promise.all([
      db.requirement.count({ where: { projectId: project.id } }),
      db.task.count({ where: { projectId: project.id } }),
      db.finding.count({ where: { projectId: project.id } }),
      db.document.count({ where: { projectId: project.id } }),
    ]);

    await db.project.delete({ where: { id: project.id } });
    process.stdout.write(
      `deleted ${project.code} (${project.name}): ` +
        `${String(requirements)} requirements, ${String(tasks)} tasks, ` +
        `${String(findings)} findings, ${String(documents)} documents\n`,
    );
  }

  // The seeded job is addressed by kind, the same way the seed addresses it.
  const jobs = await db.job.deleteMany({
    where: { kind: 'example', payload: { path: ['note'], equals: 'seeded' } },
  });
  if (jobs.count > 0) process.stdout.write(`deleted ${String(jobs.count)} seeded example job(s)\n`);

  // The acceptance test is "no orphan references remain", so check rather than assume.
  const orphans = await db.$queryRaw<{ table: string; rows: bigint }[]>`
    select 'requirement' as table, count(*) as rows from requirement r
      where not exists (select 1 from project p where p.id = r.project_id)
    union all
    select 'task', count(*) from task t
      where not exists (select 1 from project p where p.id = t.project_id)
    union all
    select 'finding', count(*) from finding f
      where not exists (select 1 from project p where p.id = f.project_id)
    union all
    select 'document', count(*) from document d
      where not exists (select 1 from project p where p.id = d.project_id)
  `;
  const left = orphans.filter((row) => Number(row.rows) > 0);
  if (left.length > 0) {
    process.stderr.write(`orphan rows remain: ${left.map((r) => `${r.table}=${String(r.rows)}`).join(', ')}\n`);
    process.exit(1);
  }
  process.stdout.write('no orphan references remain\n');
} finally {
  await db.$disconnect();
}
