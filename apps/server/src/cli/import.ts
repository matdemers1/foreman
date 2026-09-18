import { ConfigError, loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { runImport, type ImportReport } from '../import/run.js';

/**
 * The importer's front door (T-8.6, T-8.8).
 *
 * **`--dry-run` is the default.** Writing requires `--write`, explicitly. The real corpus is
 * imported exactly once, in Phase 10, and until then every run of this must be safe to make by
 * accident — the flag that protects the vault is not one you have to remember.
 *
 * ```console
 * $ pnpm import -- --path "../D3 Cloud Vault"
 * $ pnpm import -- --path "../D3 Cloud Vault" --only Bindery --json report.json
 * ```
 */

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

const path = flag('path');
if (path === undefined) {
  process.stderr.write('usage: import --path <vault> [--only Folder] [--write] [--json out.json]\n');
  process.exit(2);
}

const write = args.includes('--write');
const only = flag('only');

const config = (() => {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.problems) process.stderr.write(`  - ${problem}\n`);
      process.exit(1);
    }
    throw error;
  }
})();

const db = createDb(config.DATABASE_URL);

const report = await runImport(db, {
  path,
  dryRun: !write,
  ...(only === undefined ? {} : { only: only.split(',') }),
});

process.stdout.write(render(report));

const json = flag('json');
if (json !== undefined) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(json, JSON.stringify(report, null, 2));
  process.stdout.write(`\nreport written to ${json}\n`);
}

await db.$disconnect();
// Unmapped files are not an error — they are the report doing its job — so the exit code reflects
// whether the run completed, not what it found.
process.exit(0);

/**
 * The report, as something a person reads (S-29).
 *
 * The product of this phase is the report, not the rows: R-03 names the importer the likeliest
 * abandonment point, and what stops that is being able to see exactly what it did and did not
 * understand.
 */
function render(report: ImportReport): string {
  const lines: string[] = [];
  const { totals } = report;

  lines.push('');
  lines.push(report.dryRun ? 'DRY RUN — nothing was written' : 'WROTE TO THE DATABASE');
  lines.push(`vault: ${report.root}`);
  lines.push('');

  lines.push('projects');
  for (const project of report.projects) {
    lines.push(
      `  ${project.code.padEnd(8)} ${project.folder} (${String(project.files)} files)` +
        // A derived code is a guess at something immutable. Saying so before the write is the
        // only moment it can be corrected.
        (project.derived ? '   ← code DERIVED, not from the known map — check before writing' : ''),
    );
  }
  lines.push('');

  const byStatus = (status: string) => report.files.filter((f) => f.status === status);

  for (const status of ['partial', 'unmapped'] as const) {
    const rows = byStatus(status);
    if (rows.length === 0) continue;
    lines.push(`${status} (${String(rows.length)})`);
    for (const file of rows) {
      lines.push(`  ${file.path}`);
      lines.push(`      ${file.note ?? 'no reason recorded'}`);
    }
    lines.push('');
  }

  lines.push('entities');
  for (const [kind, n] of Object.entries(report.entities).sort()) {
    lines.push(`  ${kind.padEnd(20)} ${String(n)}`);
  }
  lines.push('');

  if (report.substitutions.length > 0) {
    lines.push(`citations rewritten: ${String(report.substitutions.length)}`);
    for (const substitution of report.substitutions.slice(0, 10)) {
      lines.push(`  ${substitution.from} → ${substitution.to}  ${substitution.file}:${String(substitution.line)}`);
    }
    if (report.substitutions.length > 10) {
      lines.push(`  … and ${String(report.substitutions.length - 10)} more (use --json to see them all)`);
    }
    lines.push('');
  }

  lines.push(
    `${String(totals.seen)} files: ${String(totals.mapped)} mapped, ` +
      `${String(totals.partial)} partial, ${String(totals.unmapped)} unmapped`,
  );
  // The line that makes the contract checkable at a glance.
  const accounted = totals.mapped + totals.partial + totals.unmapped;
  lines.push(
    accounted === totals.seen
      ? `every file is accounted for (${String(accounted)} of ${String(totals.seen)})`
      : `MISSING: ${String(totals.seen - accounted)} files are in neither column — this is a bug`,
  );
  lines.push('');

  return lines.join('\n');
}
