import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db.js';

/**
 * Issuing a scoped API token (FRM-REQ-025 … FRM-REQ-027, T-2.11).
 *
 * The CLI hard-coded `['read']`, so every token it had ever issued was read-only and the shim's
 * six write tools answered 403 — on a credential this command's own help offers for the shim.
 * The failure surfaced at the far end of an MCP call, as a scope denial naming a route.
 *
 * Driven as a process rather than imported, because the parsing and the refusals are the point
 * and both live in the script's top level.
 */

const run = promisify(execFile);
const url = process.env['DATABASE_URL'];
const SCRIPT = fileURLToPath(new URL('../../src/cli/issue-token.ts', import.meta.url));
const DEFAULTED = 'read by default';
const WRITING = 'asked for write';
const AUDITED = 'named in the audit trail';
const NAMES = [DEFAULTED, WRITING, AUDITED];

// The same shape of environment the app's own tests build, because the CLI loads the whole
// config: it writes an audit row and speaks to the database, so half a config is no config.
const ENV = {
  ...process.env,
  BASE_URL: 'http://localhost:3200',
  DATABASE_URL: url ?? '',
  KEK: Buffer.alloc(32, 1).toString('base64'),
  PEPPER: Buffer.alloc(32, 2).toString('base64'),
  COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
};

async function issue(args: string[]) {
  return run(process.execPath, ['--import', 'tsx', SCRIPT, ...args], { env: ENV });
}

describe.skipIf(url === undefined)('issue-token', () => {
  let db: Db;

  beforeAll(() => {
    db = createDb(url ?? '');
  });

  afterAll(async () => {
    await db.apiToken.deleteMany({ where: { name: { in: NAMES } } });
    await db.$disconnect();
  });

  it('issues a read-only token when nothing is asked for', async () => {
    // The safe default stays the default: widening a credential is a deliberate word.
    const { stdout } = await issue([DEFAULTED]);
    expect(stdout).toContain('scopes: read');

    const row = await db.apiToken.findFirst({ where: { name: DEFAULTED } });
    expect(row?.scopes).toEqual(['read']);
  });

  it('issues a writing token when asked', async () => {
    const { stdout } = await issue([WRITING, '--scopes', 'read,write']);
    expect(stdout).toContain('scopes: read, write');

    const row = await db.apiToken.findFirst({ where: { name: WRITING } });
    expect(row?.scopes).toEqual(['read', 'write']);
  });

  it('refuses a scope it does not know, rather than falling back to read', async () => {
    // Silently narrowing a typo would hand over a token that answers every question and fails on
    // the first write, hours later and somewhere else.
    await expect(issue(['never created', '--scopes', 'read,wirte'])).rejects.toMatchObject({
      code: 1,
    });
    expect(await db.apiToken.findFirst({ where: { name: 'never created' } })).toBeNull();
  });

  it('refuses --scopes with no value', async () => {
    await expect(issue(['never created', '--scopes'])).rejects.toMatchObject({ code: 1 });
  });

  it('records the scopes it issued, and never the token', async () => {
    const { stdout } = await issue([AUDITED, '--scopes', 'read,write,admin']);
    // Two `frm_` strings are printed: the short prefix, for recognising the row later, and the
    // secret. The longest is the one that must never be written down.
    const secret = [...stdout.matchAll(/frm_[A-Za-z0-9_-]+/g)]
      .map((match) => match[0])
      .sort((a, b) => b.length - a.length)[0];
    expect(secret?.length ?? 0).toBeGreaterThan(20);

    const row = await db.apiToken.findFirstOrThrow({ where: { name: AUDITED } });
    const event = await db.auditEvent.findFirst({
      where: { entityType: 'api_token', entityId: row.id },
    });

    expect((event?.after as { scopes: string[] } | null)?.scopes).toEqual([
      'read',
      'write',
      'admin',
    ]);
    // The 12-character prefix is deliberately stored — it is how a token is recognised in a list
    // without revealing it. The secret itself must reach neither the trail nor the row.
    expect(JSON.stringify(event?.after)).not.toContain(secret);
    expect(row.tokenHash).not.toContain(secret);
  });
});
