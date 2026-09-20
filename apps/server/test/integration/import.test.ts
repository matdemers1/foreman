import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db.js';
import { codeFor, runImport } from '../../src/import/run.js';

/**
 * The importer, against the golden fixture corpus (T-8.6 … T-8.9).
 *
 * **Never-regress test #2**: every source file appears in the report as mapped, partial or
 * unmapped with a reason, and the totals equal the input file count exactly. Silence is the
 * failure mode — a file that vanishes between the vault and the database is the one thing the
 * report exists to make impossible.
 */

const url = process.env['DATABASE_URL'];
const FIXTURES = resolve(import.meta.dirname, '../../../../fixtures/vault');
const GOLDEN = resolve(import.meta.dirname, '../fixtures/import-golden.json');

/**
 * One timeout for the file, not per test: every test here runs the importer over the real vault
 * corpus, so the 5s default is wrong for all of them rather than for the two that happened to trip
 * it on a CI runner. Locally they are a second or two each.
 */
describe.skipIf(url === undefined)('the importer', { timeout: 30_000 }, () => {
  let db: Db;

  beforeAll(() => {
    db = createDb(url ?? '');
  });

  beforeEach(async () => {
    // The fixture corpus imports as its real codes, so the test cleans exactly those.
    await db.project.deleteMany({ where: { code: { in: ['BND', 'BURR', 'CW', 'AUTH', 'PW'] } } });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: { in: ['BND', 'BURR', 'CW', 'AUTH', 'PW'] } } });
    await db.$disconnect();
  });

  describe('project codes (ADR-008)', () => {
    it('uses the code the ecosystem already uses, not one derived from the folder', () => {
      // A code is embedded in every human ID and is immutable once assigned. Deriving gave
      // `BIND`, `DA` and `CLEA`; every existing citation says `BND`, `AUTH` and `CW`.
      expect(codeFor('Bindery')).toBe('BND');
      expect(codeFor('D3 Auth')).toBe('AUTH');
      expect(codeFor('Clearwhen')).toBe('CW');
    });

    it('derives one for a folder nobody has assigned yet, deterministically', () => {
      expect(codeFor('Some New Thing')).toBe(codeFor('Some New Thing'));
      expect(codeFor('Some New Thing')).toBe('SNT');
    });
  });

  describe('the contract: every file is accounted for (FRM-REQ-148)', () => {
    it('reports every file as mapped, partial or unmapped', async () => {
      const report = await runImport(db, { path: FIXTURES, dryRun: true });
      const { totals } = report;

      expect(totals.seen).toBeGreaterThan(8);
      // The line that makes silence impossible.
      expect(totals.mapped + totals.partial + totals.unmapped).toBe(totals.seen);
      expect(report.files).toHaveLength(totals.seen);
    });

    it('gives every non-mapped file a reason', async () => {
      const report = await runImport(db, { path: FIXTURES, dryRun: true });
      const unexplained = report.files.filter(
        (f) => f.status !== 'mapped' && (f.note === null || f.note.trim() === ''),
      );
      expect(unexplained.map((f) => f.path)).toEqual([]);
    });

    it('counts a project folder with no files at all', async () => {
      // Personal Website is an overview in Master Notes and an empty folder here. A walker that
      // skips it silently loses the fact that the project exists.
      const report = await runImport(db, { path: FIXTURES, dryRun: true });
      const empty = report.projects.find((p) => p.folder === 'Personal Website');
      expect(empty?.files).toBe(0);
    });
  });

  describe('the dry run writes nothing (T-8.6, FRM-REQ-149)', () => {
    it('produces a full report and leaves the database untouched', async () => {
      const before = await db.project.count();
      const report = await runImport(db, { path: FIXTURES, dryRun: true });

      expect(report.totals.seen).toBeGreaterThan(0);
      expect(report.entities['requirement']).toBeGreaterThan(100);
      // The report is produced exactly as it would be otherwise — and nothing moved.
      expect(await db.project.count()).toBe(before);
      expect(await db.requirement.count({ where: { humanId: { startsWith: 'BND-' } } })).toBe(0);
    });
  });

  describe('idempotency (T-8.7, FRM-REQ-150)', () => {
    it('produces no duplicates when run twice', async () => {
      await runImport(db, { path: FIXTURES, dryRun: false });
      const afterFirst = {
        projects: await db.project.count({ where: { code: { in: ['BND', 'CW'] } } }),
        requirements: await db.requirement.count({ where: { humanId: { startsWith: 'BND-' } } }),
      };
      expect(afterFirst.requirements).toBeGreaterThan(100);

      await runImport(db, { path: FIXTURES, dryRun: false });

      // Every write is an upsert on a natural key, so a second run updates rather than inserts.
      expect(await db.project.count({ where: { code: { in: ['BND', 'CW'] } } })).toBe(
        afterFirst.projects,
      );
      expect(await db.requirement.count({ where: { humanId: { startsWith: 'BND-' } } })).toBe(
        afterFirst.requirements,
      );
    });


    it('imports the real register with its IDs intact', async () => {
      await runImport(db, { path: FIXTURES, dryRun: false });
      const first = await db.requirement.findFirst({ where: { humanId: 'BND-REQ-001' } });

      expect(first).not.toBeNull();
      expect(first?.statement).toContain('drag-and-drop');
      // The `Src` column of round codes survives as the source.
      expect(first?.source).toMatch(/^[A-Z]+\d*$/);
    });
  });

  describe('synthesized task IDs (T-8.4, FRM-REQ-045, FRM-REQ-151)', () => {
    it('flags a free-text scope of work as synthesized, and says so in the report', async () => {
      const report = await runImport(db, { path: FIXTURES, dryRun: true });
      const clearwhen = report.files.find((f) => f.path.includes('Clearwhen/Scope of Work'));

      // Not one task ID in the file. Synthesizing them is the only way this project imports.
      expect(clearwhen?.status).toBe('mapped');
      expect(clearwhen?.note).toContain('synthesized');
      expect(report.entities['task-synthesized']).toBeGreaterThan(20);
    });
  });

  describe('the golden diff (T-8.9)', () => {
    /**
     * The report, reduced to what should never change silently.
     *
     * Paths, statuses, reasons and counts — not timestamps or ids. A diff here means the importer
     * reads the same corpus differently than it did, which is either a fix or a regression, and
     * either way somebody should look.
     */
    const shapeOf = (report: Awaited<ReturnType<typeof runImport>>) => ({
      totals: report.totals,
      projects: report.projects.map((p) => ({ code: p.code, folder: p.folder, files: p.files })),
      files: report.files
        .map((f) => ({ path: f.path, status: f.status, kind: f.kind, note: f.note, produced: f.produced }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      entities: report.entities,
      substitutions: report.substitutions.length,
    });

    it('matches the checked-in expectation', async () => {
      const report = await runImport(db, { path: FIXTURES, dryRun: true });
      const actual = shapeOf(report);

      if (!existsSync(GOLDEN) || process.env['UPDATE_GOLDEN'] === '1') {
        writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
      }

      const expected: unknown = JSON.parse(readFileSync(GOLDEN, 'utf8'));
      expect(actual).toEqual(expected);
    });
  });
});
