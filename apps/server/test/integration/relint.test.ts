import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db.js';

/**
 * Re-linting what the importer wrote (FRM-REQ-050, FRM-REQ-051).
 *
 * The importer did not lint, so all 439 imported requirements sat on the column defaults —
 * `unparsed`, not ok, no note. `FRM-REQ-051` is "If a Requirement statement does not parse as
 * EARS, then Foreman shall store it and record a warning", a textbook unwanted-behaviour
 * statement, and it was recorded as unparseable. The engine P3 tuned against 591 real
 * requirements had never been run over one.
 */

const run = promisify(execFile);
const url = process.env['DATABASE_URL'];
const SCRIPT = fileURLToPath(new URL('../../src/cli/relint.ts', import.meta.url));
const CODE = 'RLNT';

const ENV = {
  ...process.env,
  BASE_URL: 'http://localhost:3200',
  DATABASE_URL: url ?? '',
  KEK: Buffer.alloc(32, 1).toString('base64'),
  PEPPER: Buffer.alloc(32, 2).toString('base64'),
  COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
};

const relint = (args: string[]) =>
  run(process.execPath, ['--import', 'tsx', SCRIPT, '--project', CODE, ...args], { env: ENV });

describe.skipIf(url === undefined)('relint', () => {
  let db: Db;
  let projectId: string;

  beforeAll(async () => {
    db = createDb(url ?? '');
    await db.project.deleteMany({ where: { code: CODE } });
    const project = await db.project.create({
      data: { code: CODE, name: 'Relint', slug: 'relint', lifecycle: 'building' },
    });
    projectId = project.id;

    // Written the way the importer writes: straight to the table, no lint.
    const statements = [
      'If a Requirement statement does not parse as EARS, then Foreman shall store it and record a warning',
      'While D3 Auth is unreachable, Foreman shall still permit app-native login',
      'Per-user recovery codes',
    ];
    for (const [index, statement] of statements.entries()) {
      await db.requirement.create({
        data: {
          projectId,
          humanId: `${CODE}-REQ-${String(index + 1).padStart(3, '0')}`,
          seq: index + 1,
          statement,
          priority: 'M',
        },
      });
    }
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.$disconnect();
  });

  it('writes nothing until it is told to', async () => {
    // The importer's convention: not writing is the default. This touches every requirement in
    // the archive at once, so a report you can read comes before a write you cannot see.
    const { stdout } = await relint([]);
    expect(stdout).toContain('verdict changed: 3');
    expect(stdout).toContain('Nothing written');

    const rows = await db.requirement.findMany({ where: { projectId } });
    expect(rows.every((r) => r.earsPattern === 'unparsed')).toBe(true);
  });

  it('gives each statement the pattern it actually has', async () => {
    await relint(['--write']);
    const byId = new Map(
      (await db.requirement.findMany({ where: { projectId } })).map((r) => [r.humanId, r]),
    );

    expect(byId.get(`${CODE}-REQ-001`)?.earsPattern).toBe('unwanted');
    expect(byId.get(`${CODE}-REQ-001`)?.earsLintOk).toBe(true);
    expect(byId.get(`${CODE}-REQ-002`)?.earsPattern).toBe('state');
    expect(byId.get(`${CODE}-REQ-002`)?.earsLintOk).toBe(true);
  });

  it('keeps a statement it cannot read, and says why', async () => {
    // The lint warns and never blocks (FRM-REQ-051). A requirement it cannot parse stays exactly
    // where it is, and gains the reason it was previously missing.
    const row = await db.requirement.findFirstOrThrow({
      where: { humanId: `${CODE}-REQ-003` },
    });
    expect(row.earsLintOk).toBe(false);
    expect(row.earsLintNote).not.toBeNull();
    expect(row.statement).toBe('Per-user recovery codes');
  });

  it('is idempotent: a second run changes nothing', async () => {
    const { stdout } = await relint(['--write']);
    expect(stdout).toContain('verdict changed: 0');
    expect(stdout).toContain('Nothing to do');
  });

  it('audits what it changed, with the verdict before and after', async () => {
    const event = await db.auditEvent.findFirst({
      where: { entityHumanId: `${CODE}-REQ-001`, action: 'update' },
      orderBy: { createdAt: 'desc' },
    });
    expect((event?.before as { earsPattern: string } | null)?.earsPattern).toBe('unparsed');
    expect((event?.after as { earsPattern: string } | null)?.earsPattern).toBe('unwanted');
  });
});
