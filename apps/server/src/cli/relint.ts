import { lintEars } from '@foreman/shared';
import { loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { record } from '../domain/audit.js';

/**
 * Re-run the EARS lint over requirements already in the database (FRM-REQ-050, FRM-REQ-051).
 *
 *   docker compose exec -T server node dist/cli/relint.js            # report, write nothing
 *   docker compose exec -T server node dist/cli/relint.js --write
 *
 * Needed because the importer did not lint. Every requirement it wrote — all 439 of them, across
 * nine projects — landed on the column defaults: `unparsed`, not ok, no note. So the EARS engine
 * that P3 tuned against 591 real requirements had never been run over a single real requirement,
 * and every one of them carried an attention badge on the Requirements screen with nothing behind
 * it. `FRM-REQ-051` — "If a Requirement statement does not parse as EARS, then Foreman shall store
 * it and record a warning" — is a textbook unwanted-behaviour statement, and it was recorded as
 * unparseable.
 *
 * **Not writing is the default**, as with the importer: the lint is advisory (it warns, never
 * blocks), but this touches every requirement in the archive at once, and a report you can read
 * before a write you cannot see is worth the extra word.
 *
 * Idempotent, and it only writes rows whose verdict actually changes, so a second run reports
 * nothing and touches nothing.
 */

const write = process.argv.includes('--write');
const only = (() => {
  const at = process.argv.indexOf('--project');
  return at === -1 ? undefined : process.argv[at + 1];
})();

if (process.argv.some((arg) => ['-h', '--help', 'help'].includes(arg))) {
  process.stdout.write(
    'usage: relint [--write] [--project CODE]\n\n' +
      '  Re-runs the EARS lint over every requirement. Reports by default; --write applies.\n',
  );
  process.exit(0);
}

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

try {
  const requirements = await db.requirement.findMany({
    where: {
      deletedAt: null,
      ...(only === undefined ? {} : { project: { code: only.toUpperCase() } }),
    },
    select: {
      id: true,
      humanId: true,
      statement: true,
      earsPattern: true,
      earsLintOk: true,
      earsLintNote: true,
    },
    orderBy: { humanId: 'asc' },
  });

  if (requirements.length === 0) {
    process.stdout.write(`No requirements found${only === undefined ? '' : ` for ${only}`}.\n`);
    process.exit(0);
  }

  const changed: { humanId: string; from: string; to: string; ok: boolean }[] = [];
  const byPattern = new Map<string, number>();
  let failing = 0;

  for (const requirement of requirements) {
    const ears = lintEars(requirement.statement);
    byPattern.set(ears.pattern, (byPattern.get(ears.pattern) ?? 0) + 1);
    if (!ears.ok) failing += 1;

    const differs =
      ears.pattern !== requirement.earsPattern ||
      ears.ok !== requirement.earsLintOk ||
      (ears.note ?? null) !== requirement.earsLintNote;
    if (!differs) continue;

    changed.push({
      humanId: requirement.humanId,
      from: requirement.earsPattern,
      to: ears.pattern,
      ok: ears.ok,
    });

    if (!write) continue;

    await db.$transaction(async (tx) => {
      const after = await tx.requirement.update({
        where: { id: requirement.id },
        data: {
          earsPattern: ears.pattern,
          earsLintOk: ears.ok,
          earsLintNote: ears.note ?? null,
        },
      });
      // Every mutation writes an audit event, the CLI's included (FRM-REQ-136).
      await record(tx, {
        actor: 'cli',
        actorKind: 'system',
        action: 'update',
        entityType: 'requirement',
        entityId: requirement.id,
        entityHumanId: requirement.humanId,
        before: {
          earsPattern: requirement.earsPattern,
          earsLintOk: requirement.earsLintOk,
          earsLintNote: requirement.earsLintNote,
        },
        after: {
          earsPattern: after.earsPattern,
          earsLintOk: after.earsLintOk,
          earsLintNote: after.earsLintNote,
        },
      });
    });
  }

  const patterns = [...byPattern.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([pattern, count]) => `${pattern} ${String(count)}`)
    .join(', ');

  process.stdout.write(
    `\n${String(requirements.length)} requirement(s) linted${only === undefined ? '' : ` for ${only}`}.\n` +
      `  patterns: ${patterns}\n` +
      `  not conforming: ${String(failing)}\n` +
      `  verdict changed: ${String(changed.length)}\n\n`,
  );

  // The first twenty, so a re-lint that moves everything does not bury the one row that matters.
  for (const row of changed.slice(0, 20)) {
    process.stdout.write(`  ${row.humanId}: ${row.from} -> ${row.to}${row.ok ? '' : ' (warns)'}\n`);
  }
  if (changed.length > 20) {
    process.stdout.write(`  … and ${String(changed.length - 20)} more\n`);
  }

  process.stdout.write(
    changed.length === 0
      ? '\nNothing to do.\n'
      : write
        ? '\nWritten.\n'
        : '\nNothing written. Re-run with --write to apply.\n',
  );
} finally {
  await db.$disconnect();
}
