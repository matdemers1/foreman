import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
    await db.project.deleteMany({ where: { code: { in: ['BND', 'BURR', 'CW', 'AUTH', 'PW', 'DI'] } } });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: { in: ['BND', 'BURR', 'CW', 'AUTH', 'PW', 'DI'] } } });
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

    it('gives a project with an empty folder a row, and its overview', async () => {
      // Personal Website's folder is empty; its overview lives in `Master Notes`. The project row
      // has always appeared regardless — a walker that skips an empty folder loses the fact that
      // the project exists — and the overview now comes with it, so the project is not merely a
      // name. Before that, this project imported with no content whatsoever.
      const report = await runImport(db, { path: FIXTURES, dryRun: true });
      const site = report.projects.find((p) => p.folder === 'Personal Website');

      expect(site, 'the project row exists even with an empty folder').toBeDefined();
      expect(site?.files).toBe(1);
      expect(report.files.map((f) => f.path)).toContain(
        'Master Notes/Overviews/Personal Website Overview.md',
      );
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

    it('lints what it imports, on the same terms as a requirement written through the API', async () => {
      // The importer used to skip the lint entirely, so every imported requirement landed on the
      // column defaults — `unparsed`, not ok, no note — and the EARS engine P3 tuned against 591
      // real requirements produced nothing at all for the only corpus that matters.
      await runImport(db, { path: FIXTURES, dryRun: false });
      const imported = await db.requirement.findMany({ where: { humanId: { startsWith: 'BND-' } } });

      expect(imported.length).toBeGreaterThan(100);
      expect(
        imported.some((r) => r.earsPattern !== 'unparsed'),
        'a real register is not entirely unparseable',
      ).toBe(true);
      // Warning, never blocking (FRM-REQ-072): a statement the lint cannot read is still imported,
      // and now carries the reason rather than a bare red mark.
      for (const requirement of imported) {
        if (!requirement.earsLintOk) expect(requirement.earsLintNote).not.toBeNull();
      }
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

  /**
   * d3cloud.io (2026-09-24): `### Deliverables` / `### Tasks` under each `## Phase N`, tasks
   * grouped under bold parent lines, and requirements only as a MoSCoW table. It imported as 0
   * phases, 0 requirements and 199 tasks numbered `DI-T-0.1 … 0.199`, every one a coverage hole,
   * and every file in the report said `mapped`.
   */
  describe('a scope of work with subheadings and groups, and a MoSCoW table (DI)', () => {
    it('imports its five phases, with every task in one of them', async () => {
      await runImport(db, { path: FIXTURES, dryRun: false, only: ['d3cloud.io'] });
      const project = await db.project.findFirstOrThrow({ where: { code: 'DI' } });

      const phases = await db.phase.findMany({ where: { projectId: project.id }, orderBy: { sortOrder: 'asc' } });
      expect(phases.map((p) => p.humanId)).toEqual(['DI-P-0', 'DI-P-1', 'DI-P-2', 'DI-P-3', 'DI-P-4']);
      expect(phases[0]?.name).toBe('Foundation & Deploy Proof');
      expect(phases[0]?.objective).toMatch(/^Stand up the repo/);
      expect(phases[0]?.size).toBe('M');

      const tasks = await db.task.findMany({ where: { projectId: project.id } });
      expect(tasks).toHaveLength(134);
      expect(tasks.filter((t) => t.phaseId === null)).toEqual([]);
      expect(tasks.filter((t) => t.humanId.startsWith('DI-T-4.')).length).toBeGreaterThan(0);
    });

    it('imports no bare bold heading as a task, and names the group on its children', async () => {
      await runImport(db, { path: FIXTURES, dryRun: false, only: ['d3cloud.io'] });
      const tasks = await db.task.findMany({ where: { project: { code: 'DI' } } });

      expect(tasks.filter((t) => /^\*\*[^*]+\*\*:?$/.test(t.title)).map((t) => t.title)).toEqual([]);
      expect(tasks.some((t) => t.title.startsWith('Repo setup — Initial commit'))).toBe(true);
    });

    it('makes the deliverables each phase’s exit demo, not a second copy of its tasks', async () => {
      await runImport(db, { path: FIXTURES, dryRun: false, only: ['d3cloud.io'] });
      const zero = await db.phase.findUniqueOrThrow({ where: { humanId: 'DI-P-0' } });

      expect(zero.exitDemo).toContain('`d3cloud-www/` repo created at workspace root');
      expect(zero.exitDemo?.split('\n')).toHaveLength(6);
      expect(await db.task.count({ where: { project: { code: 'DI' }, title: { contains: 'repo created at workspace root' } } })).toBe(0);
    });

    it('imports the MoSCoW table as requirements, the tier as the priority', async () => {
      await runImport(db, { path: FIXTURES, dryRun: false, only: ['d3cloud.io'] });
      const requirements = await db.requirement.findMany({ where: { project: { code: 'DI' } }, orderBy: { seq: 'asc' } });
      const count = (p: string) => requirements.filter((r) => r.priority === p).length;

      expect(requirements).toHaveLength(25);
      expect([count('M'), count('S'), count('C'), count('W')]).toEqual([9, 5, 3, 8]);
      expect(requirements[0]?.humanId).toBe('DI-REQ-001');
      expect(requirements[0]?.source).toBe('MoSCoW');
    });

    it('is idempotent on this shape too', async () => {
      await runImport(db, { path: FIXTURES, dryRun: false, only: ['d3cloud.io'] });
      await runImport(db, { path: FIXTURES, dryRun: false, only: ['d3cloud.io'] });
      expect(await db.task.count({ where: { project: { code: 'DI' } } })).toBe(134);
      expect(await db.requirement.count({ where: { project: { code: 'DI' } } })).toBe(25);
    });

    it('reports the phases in a dry run, and raises no warning', async () => {
      const report = await runImport(db, { path: FIXTURES, dryRun: true, only: ['d3cloud.io'] });
      expect(report.entities['phase']).toBe(5);
      expect(report.entities['task']).toBe(134);
      expect(report.entities['requirement']).toBe(25);
      expect(report.warnings).toEqual([]);
    });
  });

  describe('a project whose shape is wrong even though every file mapped', () => {
    it('warns on >50 tasks with no phase and no requirement, and marks the file partial', async () => {
      // What d3cloud.io looked like to the importer before the fix, reproduced directly.
      const vault = mkdtempSync(join(tmpdir(), 'foreman-shape-'));
      try {
        mkdirSync(join(vault, 'Shape'));
        const lines = ['# Shape — Scope of Work', '', '## Tasks', ''];
        for (let i = 1; i <= 60; i += 1) lines.push(`- [ ] Task number ${String(i)}`);
        writeFileSync(join(vault, 'Shape', 'Scope of Work.md'), lines.join('\n'));

        const report = await runImport(db, { path: vault, dryRun: true });
        expect(report.warnings).toHaveLength(1);
        expect(report.warnings[0]?.message).toMatch(/60 tasks, but 0 phases and 0 requirements/);

        const sow = report.files.find((f) => f.kind === 'scope-of-work');
        expect(sow?.status).toBe('partial');
        expect(sow?.note).toMatch(/not one phase heading/);
      } finally {
        rmSync(vault, { recursive: true, force: true });
      }
    });
  });

  describe("a project's overview, which lives outside its folder", () => {
    it('imports the overview from Master Notes as a document on the project', async () => {
      // `Master Notes/` is excluded from the project scan, correctly — it is not a project — and
      // every project's overview sits inside it. So the prose description of what each project *is*
      // was invisible to the importer, and Personal Website, whose folder holds nothing else at
      // all, imported as a project with no content whatsoever.
      await runImport(db, { path: FIXTURES, dryRun: false });

      const overview = await db.document.findFirst({
        where: { project: { code: 'PW' }, title: { contains: 'Overview' } },
      });
      expect(overview, 'Personal Website should have its overview').not.toBeNull();
    });
  });

  describe('the ID counters after an import', () => {
    it('leaves the counters past the IDs it just wrote', async () => {
      // `allocate` takes the next number from the counter, never from `count(*)`, so a deleted
      // `BND-REQ-007` cannot hand its number to something else. The importer writes human IDs
      // straight from the source and never touched that counter — so after a cutover the counters
      // read zero while the rows numbered into the hundreds, and the next finding created through
      // the API asked for `BND-CR-001` and hit a unique-constraint violation. Every audit skill
      // writes findings; all four would have failed on every imported project.
      await runImport(db, { path: FIXTURES, dryRun: false });

      const project = await db.project.findFirstOrThrow({ where: { code: 'BND' } });
      const counters = project.idCounters as Record<string, number>;
      const highestRequirement = await db.requirement.findFirst({
        where: { projectId: project.id },
        orderBy: { humanId: 'desc' },
        select: { humanId: true },
      });

      const written = Number((highestRequirement?.humanId ?? '').split('-').at(-1));
      expect(written).toBeGreaterThan(0);
      expect(counters['REQ'] ?? 0).toBeGreaterThanOrEqual(written);
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
