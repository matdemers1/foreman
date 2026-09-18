import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Soft delete and undo (T-2.3, T-2.4) — "nothing is unrecoverable", tested rather than asserted.
 *
 * The test that matters most is the refusal: undoing a change something else has since changed
 * again would silently discard the later edit, and refusing is the better outcome.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'undo@example.com';
const PASSWORD = 'a-password-for-the-undo-tests';
const CODE = 'UND';

describe.skipIf(url === undefined)('delete and undo', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;

  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}/api${path}`, { ...init, headers });
  };
  const post = (path: string, body?: unknown) =>
    api(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const patch = (path: string, body: unknown) =>
    api(path, { method: 'PATCH', body: JSON.stringify(body) });

  const lastEvent = async (action?: 'create' | 'update' | 'delete' | 'undo') =>
    db.auditEvent.findFirstOrThrow({
      where: { entityHumanId: { startsWith: CODE }, ...(action === undefined ? {} : { action }) },
      orderBy: { createdAt: 'desc' },
    });

  beforeAll(async () => {
    const config: Config = loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:3200',
      DATABASE_URL: url ?? '',
      KEK: Buffer.alloc(32, 1).toString('base64'),
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
    });
    db = createDb(url ?? '');

    await db.user.deleteMany({ where: { email: EMAIL } });
    const user = await db.user.create({
      data: { email: EMAIL, displayName: 'Undo', status: 'active' },
    });
    await setPassword({ db, config }, user.id, PASSWORD);

    server = await new Promise<Server>((resolve) => {
      const s = createApp({ config, db }).listen(0, () => { resolve(s); });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    origin = `http://127.0.0.1:${String(address.port)}`;

    const signIn = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  beforeEach(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.auditEvent.deleteMany({ where: { entityHumanId: { startsWith: CODE } } });
    await post('/projects', { code: CODE, name: 'Undo Test' });
    await post(`/projects/${CODE}/requirements`, {
      statement: 'Foreman shall make every mutation reversible.',
    });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  describe('soft delete (FRM-REQ-140)', () => {
    it('keeps the row and stamps it, rather than removing it', async () => {
      const res = await api(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { method: 'DELETE' });
      expect(res.status).toBe(204);

      const row = await db.requirement.findFirstOrThrow({ where: { humanId: `${CODE}-REQ-001` } });
      expect(row.deletedAt).not.toBeNull();
      // Still there, which is the whole point: a delete that removes cannot be undone.
      expect(row.statement).toContain('reversible');
    });

    it('hides a deleted entity from lists and lookups', async () => {
      await api(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { method: 'DELETE' });

      const listed = (await (await api(`/projects/${CODE}/requirements`)).json()) as {
        items: unknown[];
      };
      expect(listed.items).toEqual([]);
      expect((await api(`/entities/${CODE}-REQ-001`)).status).toBe(404);
    });

    it('records what it deleted, so there is something to restore from', async () => {
      await api(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { method: 'DELETE' });

      const event = await lastEvent('delete');
      const before = event.before as { statement: string };
      expect(before.statement).toContain('reversible');
    });

    it('404s a delete of something already deleted', async () => {
      await api(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { method: 'DELETE' });
      const again = await api(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { method: 'DELETE' });
      expect(again.status).toBe(404);
    });
  });

  describe('undo (FRM-REQ-138, FRM-REQ-139)', () => {
    it('restores a deleted entity', async () => {
      await api(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { method: 'DELETE' });
      const deletion = await lastEvent('delete');

      const res = await post(`/undo/${deletion.id}`);
      expect(res.status).toBe(200);

      const row = await db.requirement.findFirstOrThrow({ where: { humanId: `${CODE}-REQ-001` } });
      expect(row.deletedAt).toBeNull();
      expect((await api(`/entities/${CODE}-REQ-001`)).status).toBe(200);
    });

    it('puts an edited field back the way it was', async () => {
      await patch(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { priority: 'C' });
      const edit = await lastEvent('update');

      await post(`/undo/${edit.id}`);

      const row = await db.requirement.findFirstOrThrow({ where: { humanId: `${CODE}-REQ-001` } });
      expect(row.priority).toBe('M');
    });

    it('reverses a creation by deleting what it made', async () => {
      const created = await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall be undone.',
      });
      expect(created.status).toBe(201);
      const creation = await lastEvent('create');

      await post(`/undo/${creation.id}`);
      const row = await db.requirement.findFirstOrThrow({ where: { humanId: `${CODE}-REQ-002` } });
      expect(row.deletedAt).not.toBeNull();
    });

    it('audits the reversal itself, and stamps the original', async () => {
      await patch(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { priority: 'S' });
      const edit = await lastEvent('update');

      const res = await post(`/undo/${edit.id}`);
      const body = (await res.json()) as { reversalEventId: string };

      const reversal = await db.auditEvent.findUniqueOrThrow({ where: { id: body.reversalEventId } });
      expect(reversal.action).toBe('undo');

      const original = await db.auditEvent.findUniqueOrThrow({ where: { id: edit.id } });
      expect(original.undoneAt).not.toBeNull();
      expect(original.undoneByEventId).toBe(body.reversalEventId);
    });

    it('refuses to undo the same change twice', async () => {
      await patch(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { priority: 'S' });
      const edit = await lastEvent('update');

      expect((await post(`/undo/${edit.id}`)).status).toBe(200);
      const again = await post(`/undo/${edit.id}`);
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toContain('already been undone');
    });

    it('refuses when the entity has changed since — the assertion undo exists for', async () => {
      await patch(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { priority: 'S' });
      const firstEdit = await lastEvent('update');

      // Somebody else edits the same field afterwards.
      await patch(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { priority: 'C' });

      const res = await post(`/undo/${firstEdit.id}`);
      expect(res.status).toBe(409);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain('priority');
      expect(error).toContain('discard the later edit');

      // And the later edit survives, which is the point of refusing.
      const row = await db.requirement.findFirstOrThrow({ where: { humanId: `${CODE}-REQ-001` } });
      expect(row.priority).toBe('C');
    });

    it('refuses to undo a reversal, rather than quietly redoing', async () => {
      await patch(`/projects/${CODE}/requirements/${CODE}-REQ-001`, { priority: 'S' });
      const edit = await lastEvent('update');
      const res = await post(`/undo/${edit.id}`);
      const { reversalEventId } = (await res.json()) as { reversalEventId: string };

      const redo = await post(`/undo/${reversalEventId}`);
      expect(redo.status).toBe(409);
      expect(((await redo.json()) as { error: string }).error).toContain('itself a reversal');
    });

    it('404s an audit event that does not exist', async () => {
      const res = await post('/undo/01a0b000-0000-7000-8000-000000000000');
      expect(res.status).toBe(404);
    });

    it('requires authentication', async () => {
      const deletion = await lastEvent();
      const res = await fetch(`${origin}/api/undo/${deletion.id}`, { method: 'POST' });
      expect(res.status).toBe(401);
    });
  });

  describe('the audit trail never holds secrets (T-2.2)', () => {
    it('redacts password material from a snapshot', async () => {
      const user = await db.user.findFirstOrThrow({ where: { email: EMAIL } });
      const credential = await db.credential.findUniqueOrThrow({ where: { userId: user.id } });

      const { scrub } = await import('../../src/domain/audit.js');
      const scrubbed = scrub(credential) as Record<string, unknown>;

      expect(scrubbed['passwordHash']).toBe('[redacted]');
      expect(JSON.stringify(scrubbed)).not.toContain(credential.passwordHash);
    });

    it('redacts a token hash and a TOTP secret wherever they appear', async () => {
      const { scrub } = await import('../../src/domain/audit.js');
      const scrubbed = JSON.stringify(
        scrub({
          name: 'a token',
          tokenHash: 'abc123',
          nested: { totpSecret: 'JBSWY3DPEHPK3PXP', fine: 'kept' },
        }),
      );

      expect(scrubbed).not.toContain('abc123');
      expect(scrubbed).not.toContain('JBSWY3DPEHPK3PXP');
      expect(scrubbed).toContain('kept');
    });

    it('records a phase number as a number, not as a Decimal’s internals', async () => {
      await post(`/projects/${CODE}/phases`, { number: 8.5, name: 'The half phase' });
      const event = await lastEvent('create');
      expect((event.after as { number: unknown }).number).toBe('8.5');
    });
  });
});
