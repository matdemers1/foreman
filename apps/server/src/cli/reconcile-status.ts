import { loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { rollupPhase, rollupProject, type RolledUp } from '../domain/rollup.js';

/**
 * Apply the status rollup to every phase and project already stored (FRM-REQ-185).
 *
 *   docker compose exec -T server node dist/cli/reconcile-status.js            # report only
 *   docker compose exec -T server node dist/cli/reconcile-status.js --write
 *
 * The rollup runs when a task changes. Everything written before it existed — every phase the
 * importer left `planned` and nobody moved — only changes when one of its tasks next does, which
 * for a finished phase is never. This is that one pass.
 *
 * **A report is the same code as the write**: each project runs in a transaction that is rolled
 * back unless `--write` is given, so what it prints is exactly what `--write` would do — gate
 * refusals included — and not a second implementation of the rules that could disagree.
 *
 * **It only promotes.** A phase marked complete over tasks still open is reported and left alone
 * (see `RollupOptions.promoteOnly`). Idempotent: a second run finds nothing to move.
 */

const write = process.argv.includes('--write');
const only = (() => {
  const at = process.argv.indexOf('--project');
  return at === -1 ? undefined : process.argv[at + 1]?.toUpperCase();
})();

if (process.argv.some((arg) => ['-h', '--help', 'help'].includes(arg))) {
  process.stdout.write(
    'usage: reconcile-status [--write] [--project CODE]\n\n' +
      '  Derives phase status from tasks and project lifecycle from phases.\n' +
      '  Reports by default; --write applies.\n',
  );
  process.exit(0);
}

class DryRun extends Error {}

const ACTOR = { actor: 'cli', actorKind: 'system' as const };
const CAUSE = 'reconcile-status';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

try {
  const projects = await db.project.findMany({
    where: { deletedAt: null, ...(only === undefined ? {} : { code: only }) },
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  });
  if (projects.length === 0) {
    process.stdout.write(`No projects found${only === undefined ? '' : ` for ${only}`}.\n`);
    process.exit(0);
  }

  const moved: RolledUp[] = [];
  for (const project of projects) {
    const mine: RolledUp[] = [];
    try {
      await db.$transaction(
        async (tx) => {
          const phases = await tx.phase.findMany({
            where: { projectId: project.id, deletedAt: null },
            select: { id: true },
            orderBy: { sortOrder: 'asc' },
          });
          for (const phase of phases) mine.push(...(await rollupPhase(tx, ACTOR, phase.id, CAUSE, { promoteOnly: true })));
          // A project with no phase that moved can still be behind its phases.
          mine.push(...(await rollupProject(tx, ACTOR, project.id, CAUSE)));
          if (!write) throw new DryRun();
        },
        { timeout: 60_000 },
      );
    } catch (error) {
      if (!(error instanceof DryRun)) throw error;
    }
    moved.push(...mine);
  }

  const held = moved.filter((row) => row.held === true);
  const final = moved.filter((row) => row.held !== true);

  for (const row of final) {
    process.stdout.write(`  ${row.humanId.padEnd(12)} ${row.kind.padEnd(8)} ${row.from} -> ${row.to}\n`);
  }
  if (held.length > 0) {
    process.stdout.write(
      `\n${String(held.length)} closed phase(s) held: their tasks say otherwise, and a backfill ` +
        'does not reopen a phase. Settle each by hand — tick the tasks or reopen the phase.\n',
    );
    for (const row of held) {
      process.stdout.write(`  ${row.humanId.padEnd(12)} ${row.from}, tasks say ${row.to}\n`);
    }
  }
  process.stdout.write(
    `\n${String(projects.length)} project(s) reconciled; ${String(final.length)} status(es) ` +
      `${write ? 'moved' : 'would move'}.\n` +
      (final.length === 0 ? 'Nothing to do.\n' : write ? 'Written.\n' : 'Nothing written. Re-run with --write to apply.\n'),
  );
} finally {
  await db.$disconnect();
}
