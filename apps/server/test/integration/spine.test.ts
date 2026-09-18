import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * The spine over HTTP (T-1.2 … T-1.5): projects, phases, requirements, tasks.
 *
 * These are the assertions the plan calls out by name — an immutable project code, a phase order
 * that disagrees with its numbering, a blocked task that must say why, and a requirement with no
 * phase at all.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'spine@example.com';
const PASSWORD = 'a-password-for-the-spine-tests';

describe.skipIf(url === undefined)('the spine', () => {
  let db: Db;
  let config: Config;
  let server: Server;
  let origin: string;
  let cookie: string;

  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${origin}/api${path}`, {
      ...init,
      headers: {
        cookie,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
    });

  const post = (path: string, body: unknown) =>
    api(path, { method: 'POST', body: JSON.stringify(body) });
  const patch = (path: string, body: unknown) =>
    api(path, { method: 'PATCH', body: JSON.stringify(body) });

  beforeAll(async () => {
    config = loadConfig({
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
      data: { email: EMAIL, displayName: 'Spine', status: 'active' },
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
    await db.project.deleteMany({ where: { code: { in: ['SPN', 'OTH'] } } });
    await db.auditEvent.deleteMany({ where: { entityHumanId: { startsWith: 'SPN' } } });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: { in: ['SPN', 'OTH'] } } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  const makeProject = async () => {
    const res = await post('/projects', { code: 'SPN', name: 'Spine Test' });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; code: string; slug: string };
  };

  describe('projects (FRM-REQ-031, FRM-REQ-032)', () => {
    it('creates a project and derives a slug', async () => {
      const project = await makeProject();
      expect(project.code).toBe('SPN');
      expect(project.slug).toBe('spine-test');
    });

    it('refuses a duplicate code', async () => {
      await makeProject();
      const again = await post('/projects', { code: 'SPN', name: 'Something else' });
      expect(again.status).toBe(409);
    });

    it('cannot change a code — it is not a field an update has', async () => {
      await makeProject();
      const res = await patch('/projects/SPN', { code: 'NEW', name: 'Renamed' });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { code: string; name: string };
      expect(body.code).toBe('SPN');
      expect(body.name).toBe('Renamed');
      // And the new code resolves to nothing, because it was never applied.
      expect((await api('/projects/NEW')).status).toBe(404);
    });

    it('writes an audit event for every mutation', async () => {
      const project = await makeProject();
      await patch('/projects/SPN', { name: 'Renamed' });

      const events = await db.auditEvent.findMany({
        where: { entityId: project.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(events.map((e) => e.action)).toEqual(['create', 'update']);
      expect(events[0]?.actor).toBe(EMAIL);
      expect(events[1]?.before).toMatchObject({ name: 'Spine Test' });
    });

    it('refuses an unauthenticated request outright', async () => {
      const res = await fetch(`${origin}/api/projects`);
      expect(res.status).toBe(401);
    });
  });

  describe('phases (FRM-REQ-034, FRM-REQ-035)', () => {
    it('renders the real Bindery case: 0, 8.5, 9, 13, 16, 12 in build order', async () => {
      await makeProject();
      // The order they were authored in is the order they are being built in.
      for (const [index, number] of [0, 8.5, 9, 13, 16, 12].entries()) {
        const res = await post('/projects/SPN/phases', {
          number,
          name: `Phase ${String(number)}`,
        });
        expect(res.status, `phase ${String(number)} at position ${String(index)}`).toBe(201);
      }

      const listed = (await (await api('/projects/SPN/phases')).json()) as {
        items: { number: string; humanId: string }[];
      };
      // Not sorted numerically — 12 comes last because that is when it is being built.
      expect(listed.items.map((p) => Number(p.number))).toEqual([0, 8.5, 9, 13, 16, 12]);
      expect(listed.items[1]?.humanId).toBe('SPN-P-8.5');
    });

    it('refuses a second phase with the same number', async () => {
      await makeProject();
      await post('/projects/SPN/phases', { number: 1, name: 'One' });
      expect((await post('/projects/SPN/phases', { number: 1, name: 'Also one' })).status).toBe(409);
    });
  });

  describe('requirements (FRM-REQ-036)', () => {
    it('lints EARS as a warning, never a rejection', async () => {
      await makeProject();
      const res = await post('/projects/SPN/requirements', {
        statement: 'This is not EARS notation in the slightest.',
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { earsPattern: string; earsLintOk: boolean; earsLintNote: string };
      expect(body.earsPattern).toBe('unparsed');
      expect(body.earsLintOk).toBe(false);
      expect(body.earsLintNote).toContain('shall');
    });

    it('stores a requirement with no phase — that is the backlog', async () => {
      await makeProject();
      const res = await post('/projects/SPN/requirements', {
        statement: 'Foreman shall keep a backlog.',
      });
      const body = (await res.json()) as { phaseId: string | null; humanId: string };
      expect(body.phaseId).toBeNull();
      expect(body.humanId).toBe('SPN-REQ-001');
    });

    it('never reuses a sequence, even after a delete', async () => {
      await makeProject();
      await post('/projects/SPN/requirements', { statement: 'Foreman shall do one thing.' });
      const second = await post('/projects/SPN/requirements', {
        statement: 'Foreman shall do another.',
      });
      const { humanId } = (await second.json()) as { humanId: string };
      expect(humanId).toBe('SPN-REQ-002');

      // Delete it, then add another: the number must move on, because a document body may cite
      // SPN-REQ-002 and must never resolve to something else.
      await db.requirement.deleteMany({ where: { humanId } });
      const third = await post('/projects/SPN/requirements', { statement: 'Foreman shall go on.' });
      expect(((await third.json()) as { humanId: string }).humanId).toBe('SPN-REQ-003');
    });

    it('finds the coverage hole: requirements no task cites', async () => {
      await makeProject();
      await post('/projects/SPN/requirements', { statement: 'Foreman shall be covered.' });
      await post('/projects/SPN/requirements', { statement: 'Foreman shall be uncovered.' });

      const covered = await db.requirement.findFirstOrThrow({ where: { humanId: 'SPN-REQ-001' } });
      await post('/projects/SPN/tasks', {
        title: 'Covers the first',
        requirementIds: [covered.id],
      });

      const uncovered = (await (
        await api('/projects/SPN/requirements?uncovered=true')
      ).json()) as { items: { humanId: string }[] };
      expect(uncovered.items.map((r) => r.humanId)).toEqual(['SPN-REQ-002']);
    });
  });

  describe('tasks (FRM-REQ-038 … FRM-REQ-043)', () => {
    it('refuses a blocked task with no reason, with a typed error', async () => {
      await makeProject();
      const res = await post('/projects/SPN/tasks', { title: 'Stuck', status: 'blocked' });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { fields: { path: string; message: string }[] };
      expect(body.fields[0]?.path).toBe('blockedReason');
    });

    it('refuses becoming blocked in an update, where only the status is sent', async () => {
      await makeProject();
      await post('/projects/SPN/tasks', { title: 'Fine for now' });

      // The body alone is valid; it is the merged state that is not.
      const res = await patch('/projects/SPN/tasks/SPN-T-001', { status: 'blocked' });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { fields: { path: string }[] }).fields[0]?.path).toBe(
        'blockedReason',
      );
    });

    it('lets one task cite three requirements', async () => {
      await makeProject();
      const ids: string[] = [];
      for (const n of [1, 2, 3]) {
        const res = await post('/projects/SPN/requirements', {
          statement: `Foreman shall satisfy case ${String(n)}.`,
        });
        ids.push(((await res.json()) as { id: string }).id);
      }

      const created = await post('/projects/SPN/tasks', {
        title: 'Satisfies three',
        requirementIds: ids,
        files: ['apps/server/src/one.ts', 'apps/server/src/two.ts'],
      });
      expect(created.status).toBe(201);

      const listed = (await (await api('/projects/SPN/tasks')).json()) as {
        items: { requirements: string[]; files: string[] }[];
      };
      expect(listed.items[0]?.requirements.sort()).toEqual([
        'SPN-REQ-001',
        'SPN-REQ-002',
        'SPN-REQ-003',
      ]);
      expect(listed.items[0]?.files).toHaveLength(2);
    });

    it('names a task after its phase and position', async () => {
      await makeProject();
      const phase = await post('/projects/SPN/phases', { number: 8.5, name: 'The half phase' });
      const { id } = (await phase.json()) as { id: string };

      const first = await post('/projects/SPN/tasks', { title: 'First', phaseId: id });
      const second = await post('/projects/SPN/tasks', { title: 'Second', phaseId: id });

      expect(((await first.json()) as { humanId: string }).humanId).toBe('SPN-T-8.5.1');
      expect(((await second.json()) as { humanId: string }).humanId).toBe('SPN-T-8.5.2');
    });

    it('refuses a task pointed at another project’s phase', async () => {
      await makeProject();
      await post('/projects', { code: 'OTH', name: 'Other' });
      const other = await post('/projects/OTH/phases', { number: 1, name: 'Theirs' });
      const { id } = (await other.json()) as { id: string };

      const res = await post('/projects/SPN/tasks', { title: 'Wrong project', phaseId: id });
      expect(res.status).toBe(422);
    });

    it('timestamps a task when it starts and when it is done', async () => {
      await makeProject();
      await post('/projects/SPN/tasks', { title: 'Timed' });

      await patch('/projects/SPN/tasks/SPN-T-001', { status: 'in_progress' });
      const started = await db.task.findFirstOrThrow({ where: { humanId: 'SPN-T-001' } });
      expect(started.startedAt).not.toBeNull();

      await patch('/projects/SPN/tasks/SPN-T-001', { status: 'done' });
      const done = await db.task.findFirstOrThrow({ where: { humanId: 'SPN-T-001' } });
      expect(done.completedAt).not.toBeNull();
      // The start is not overwritten by finishing.
      expect(done.startedAt?.getTime()).toBe(started.startedAt?.getTime());
    });
  });

  describe('paging (FRM-REQ-092)', () => {
    it('bounds every list and pages with a cursor', async () => {
      await makeProject();
      for (let i = 0; i < 5; i++) {
        await post('/projects/SPN/requirements', {
          statement: `Foreman shall satisfy case ${String(i)}.`,
        });
      }

      const first = (await (await api('/projects/SPN/requirements?limit=2')).json()) as {
        items: { humanId: string }[];
        nextCursor: string | null;
      };
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = (await (
        await api(`/projects/SPN/requirements?limit=2&cursor=${String(first.nextCursor)}`)
      ).json()) as { items: { humanId: string }[] };
      expect(second.items).toHaveLength(2);
      // A page never repeats what the one before it returned.
      expect(second.items[0]?.humanId).not.toBe(first.items[0]?.humanId);
    });

    it('refuses an unbounded request rather than honouring it', async () => {
      await makeProject();
      expect((await api('/projects/SPN/requirements?limit=100000')).status).toBe(400);
    });
  });
});
