import { execFile } from 'node:child_process';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Status rollup (FRM-T-11.5 — FRM-REQ-183, FRM-REQ-184, FRM-REQ-185).
 *
 * Through the API, because the response is where a caller — Claude over MCP included — learns that
 * closing one task completed a phase. The gate and undo are the two cases that matter most: a
 * rollup that skips the gate makes "complete" mean nothing, and one that undo cannot follow leaves
 * a phase claiming work that was taken back.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'rollup@example.com';
const PASSWORD = 'a-password-for-the-rollup-tests';
const CODE = 'RLUP';
const RECONCILE = fileURLToPath(new URL('../../src/cli/reconcile-status.ts', import.meta.url));
const reconcile = (args: string[]) =>
  promisify(execFile)(process.execPath, ['--import', 'tsx', RECONCILE, '--project', CODE, ...args], {
    env: {
      ...process.env,
      BASE_URL: 'http://localhost:3200',
      DATABASE_URL: url ?? '',
      KEK: Buffer.alloc(32, 1).toString('base64'),
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
    },
  });

interface Moved {
  humanId: string;
  kind: string;
  from: string;
  to: string;
}

describe.skipIf(url === undefined)('status rollup', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;
  let phaseId: string;

  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}/api${path}`, { ...init, headers });
  };
  const post = async (path: string, body?: unknown) => {
    const res = await api(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    return (await res.json()) as Record<string, unknown>;
  };
  const patch = async (path: string, body: unknown) => {
    const res = await api(path, { method: 'PATCH', body: JSON.stringify(body) });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as { rolledUp: Moved[] } & Record<string, unknown>;
  };
  const setTask = (n: number, status: string, extra: Record<string, unknown> = {}) =>
    patch(`/projects/${CODE}/tasks/${CODE}-T-1.${String(n)}`, { status, ...extra });

  const phase = () => db.phase.findFirstOrThrow({ where: { humanId: `${CODE}-P-1` } });
  const project = () => db.project.findFirstOrThrow({ where: { code: CODE } });

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
      data: { email: EMAIL, displayName: 'Rollup', status: 'active' },
    });
    await setPassword({ db, config }, user.id, PASSWORD);

    server = await new Promise<Server>((resolve) => {
      const s = createApp({ config, db }).listen(0, () => {
        resolve(s);
      });
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
    await db.auditEvent.deleteMany({
      where: { OR: [{ entityHumanId: { startsWith: CODE } }, { actor: { contains: CODE } }] },
    });
    await post('/projects', { code: CODE, name: 'Rollup Test' });
    const created = await post(`/projects/${CODE}/phases`, {
      number: 1,
      name: 'The only phase',
      exitDemo: 'Everything in it is done.',
    });
    phaseId = String(created['id']);
    for (const title of ['First', 'Second']) {
      await post(`/projects/${CODE}/tasks`, { title, phaseId });
    }
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    await db.$disconnect();
  });

  it('starts a planned phase, and its project, when a task starts', async () => {
    const res = await setTask(1, 'in_progress');

    expect(res.rolledUp).toEqual([
      { humanId: `${CODE}-P-1`, kind: 'phase', from: 'planned', to: 'active' },
      { humanId: CODE, kind: 'project', from: 'planned', to: 'building' },
    ]);
    const after = await phase();
    expect(after.status).toBe('active');
    expect(after.startedAt).not.toBeNull();
  });

  it('completes the phase when the last task closes and the gate passes', async () => {
    await setTask(1, 'done');
    const res = await setTask(2, 'cancelled');

    expect(res.rolledUp).toContainEqual({
      humanId: `${CODE}-P-1`,
      kind: 'phase',
      from: 'active',
      to: 'complete',
    });
    const after = await phase();
    expect(after.status).toBe('complete');
    expect(after.completedAt).not.toBeNull();
  });

  it('takes the project to deployed once every phase is closed', async () => {
    await setTask(1, 'done');
    await setTask(2, 'done');
    expect((await project()).lifecycle).toBe('deployed');
  });

  it('leaves the phase active when the exit gate fails', async () => {
    // A Must in the phase that no task satisfies: the gate names it and refuses.
    await post(`/projects/${CODE}/requirements`, {
      statement: 'The system shall be tested.',
      priority: 'M',
      phaseId,
    });
    await setTask(1, 'done');
    const res = await setTask(2, 'done');

    expect(res.rolledUp.filter((row) => row.kind === 'phase')).toEqual([]);
    expect((await phase()).status).toBe('active');
    expect((await project()).lifecycle).toBe('building');
  });

  it('cancels a phase whose every task was cancelled', async () => {
    await setTask(1, 'cancelled');
    await setTask(2, 'cancelled');
    expect((await phase()).status).toBe('cancelled');
    // Nothing was delivered, so nothing is deployed.
    expect((await project()).lifecycle).toBe('planned');
  });

  it('reopens a complete phase when a task is reopened, and clears its completion date', async () => {
    await setTask(1, 'done');
    await setTask(2, 'done');
    const res = await setTask(2, 'in_progress');

    expect(res.rolledUp).toContainEqual({
      humanId: `${CODE}-P-1`,
      kind: 'phase',
      from: 'complete',
      to: 'active',
    });
    const after = await phase();
    expect(after.status).toBe('active');
    expect(after.completedAt).toBeNull();
    // Promotion only: the project stays deployed.
    expect((await project()).lifecycle).toBe('deployed');
  });

  it('reopens a complete phase when new work is filed into it', async () => {
    await setTask(1, 'done');
    await setTask(2, 'done');
    const created = await post(`/projects/${CODE}/tasks`, { title: 'Third', phaseId });

    expect(created['rolledUp']).toContainEqual({
      humanId: `${CODE}-P-1`,
      kind: 'phase',
      from: 'complete',
      to: 'active',
    });
  });

  it('never touches a parked phase', async () => {
    await patch(`/projects/${CODE}/phases/${CODE}-P-1`, { status: 'parked' });
    await setTask(1, 'done');
    await setTask(2, 'done');
    expect((await phase()).status).toBe('parked');
  });

  it('completes a phase when its last open task is deleted', async () => {
    await setTask(1, 'done');
    const res = await api(`/projects/${CODE}/tasks/${CODE}-T-1.2`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect((await phase()).status).toBe('complete');
  });

  it('records each rollup as its own system event naming the cause', async () => {
    await setTask(1, 'in_progress');

    const events = await db.auditEvent.findMany({
      where: { entityHumanId: { in: [`${CODE}-P-1`, CODE] }, actorKind: 'system' },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => [e.entityType, e.actor])).toEqual([
      ['phase', `rollup via ${CODE}-T-1.1`],
      ['project', `rollup via ${CODE}-T-1.1`],
    ]);
  });

  it('follows an undo: reversing the closing task reopens the phase', async () => {
    await setTask(1, 'done');
    await setTask(2, 'done');
    expect((await phase()).status).toBe('complete');

    const closing = await db.auditEvent.findFirstOrThrow({
      where: { entityHumanId: `${CODE}-T-1.2`, action: 'update' },
      orderBy: { createdAt: 'desc' },
    });
    await post(`/undo/${closing.id}`);

    expect((await phase()).status).toBe('active');
  });

  it('rolls up both phases when a task moves between them', async () => {
    const second = await post(`/projects/${CODE}/phases`, { number: 2, name: 'Second phase' });
    await setTask(1, 'done');
    await setTask(2, 'in_progress');

    // Moving the open task out leaves P-1 with only done work, and starts P-2.
    const res = await setTask(2, 'in_progress', { phaseId: second['id'] });
    expect(res.rolledUp).toEqual(
      expect.arrayContaining([
        { humanId: `${CODE}-P-1`, kind: 'phase', from: 'active', to: 'complete' },
        { humanId: `${CODE}-P-2`, kind: 'phase', from: 'planned', to: 'active' },
      ]),
    );
  });

  describe('reconcile-status (FRM-REQ-185)', () => {
    it('reports without writing, then writes, then finds nothing left', async () => {
      // Work done before the rollup existed: tasks closed, phase never moved.
      await db.task.updateMany({ where: { phaseId }, data: { status: 'done' } });

      const dry = await reconcile([]);
      expect(dry.stdout).toContain(`${CODE}-P-1`);
      expect(dry.stdout).toContain('planned -> complete');
      expect((await phase()).status).toBe('planned');

      await reconcile(['--write']);
      expect((await phase()).status).toBe('complete');
      expect((await project()).lifecycle).toBe('deployed');

      expect((await reconcile([])).stdout).toContain('Nothing to do.');
    });

    it('holds a complete phase whose tasks were never ticked, rather than reopening it', async () => {
      // The importer's shape: the vault said the phase was done; the checkboxes never did.
      await db.phase.update({ where: { id: phaseId }, data: { status: 'complete' } });

      const run = await reconcile(['--write']);
      expect(run.stdout).toContain('held');
      expect(run.stdout).toContain(`${CODE}-P-1`);
      expect((await phase()).status).toBe('complete');
    });
  });

  it('rolls nothing up for an edit that is not a status or a move', async () => {
    const res = await patch(`/projects/${CODE}/tasks/${CODE}-T-1.1`, { title: 'Renamed' });
    expect(res.rolledUp).toEqual([]);
    expect((await phase()).status).toBe('planned');
  });
});
