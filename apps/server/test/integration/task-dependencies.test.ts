import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { Brief } from '../../src/domain/brief.js';

/**
 * Task dependencies (FRM-T-11.1).
 *
 * The assertion that matters is the first one: a task waiting on unfinished work is never offered
 * as next. Several agents taking the top of the brief at once is exactly the reader that would
 * believe it, and a server skeleton built before its scaffold is the cost.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'deps@example.com';
const PASSWORD = 'a-password-for-the-dependency-tests';
const CODE = 'DEP';
const OTHER = 'DEPX';

describe.skipIf(url === undefined)('task dependencies', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;
  let projectId: string;
  let phaseId: string;

  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}/api${path}`, { ...init, headers });
  };
  const link = (from: string, to: string, extra: Record<string, unknown> = {}) =>
    api('/links', {
      method: 'POST',
      body: JSON.stringify({ from, to, kind: 'depends_on', ...extra }),
    });
  const get = async <T>(path: string): Promise<T> => {
    const res = await api(path);
    expect(res.status, path).toBe(200);
    return (await res.json()) as T;
  };
  const nextIds = async () =>
    (await get<Brief>(`/brief/${CODE}`)).nextTasks.map((task) => task.humanId);

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
      data: { email: EMAIL, displayName: 'Deps', status: 'active' },
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
    await db.project.deleteMany({ where: { code: { in: [CODE, OTHER] } } });
    const project = await db.project.create({
      data: { code: CODE, name: 'Dependency Test', slug: 'dependency-test', lifecycle: 'building' },
    });
    projectId = project.id;
    const phase = await db.phase.create({
      data: {
        projectId,
        humanId: `${CODE}-P-0`,
        number: 0,
        sortOrder: 0,
        name: 'Foundation',
        status: 'active',
      },
    });
    phaseId = phase.id;

    // The shape that motivated this: a scaffold, and two things that need it.
    for (const [n, title] of [
      [1, 'Scaffold the monorepo'],
      [2, 'Server skeleton'],
      [3, 'Schema package'],
    ] as const) {
      await db.task.create({
        data: {
          projectId,
          phaseId,
          humanId: `${CODE}-T-0.${String(n)}`,
          title,
          sortOrder: n,
          files: { create: [{ path: `part-${String(n)}/index.ts` }] },
        },
      });
    }
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: { in: [CODE, OTHER] } } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  it('holds a task out of the brief until what it depends on is done (FRM-REQ-179)', async () => {
    expect(await nextIds()).toEqual([`${CODE}-T-0.1`, `${CODE}-T-0.2`, `${CODE}-T-0.3`]);

    expect((await link(`${CODE}-T-0.2`, `${CODE}-T-0.1`)).status).toBe(200);
    expect((await link(`${CODE}-T-0.3`, `${CODE}-T-0.1`)).status).toBe(200);

    let brief = await get<Brief>(`/brief/${CODE}`);
    expect(brief.nextTasks.map((t) => t.humanId)).toEqual([`${CODE}-T-0.1`]);
    expect(brief.waitingOnDependencies).toBe(2);

    // Started is not finished: the dependents still wait.
    await db.task.update({ where: { humanId: `${CODE}-T-0.1` }, data: { status: 'in_progress' } });
    expect(await nextIds()).toEqual([`${CODE}-T-0.1`]);

    await db.task.update({ where: { humanId: `${CODE}-T-0.1` }, data: { status: 'done' } });
    brief = await get<Brief>(`/brief/${CODE}`);
    expect(brief.nextTasks.map((t) => t.humanId)).toEqual([`${CODE}-T-0.2`, `${CODE}-T-0.3`]);
    expect(brief.waitingOnDependencies).toBe(0);
  });

  it('releases a dependent when its prerequisite is cancelled or deleted, not only done', async () => {
    await link(`${CODE}-T-0.2`, `${CODE}-T-0.1`);
    await link(`${CODE}-T-0.3`, `${CODE}-T-0.2`);

    await db.task.update({ where: { humanId: `${CODE}-T-0.1` }, data: { status: 'cancelled' } });
    expect(await nextIds()).toEqual([`${CODE}-T-0.2`]);

    await db.task.update({ where: { humanId: `${CODE}-T-0.2` }, data: { deletedAt: new Date() } });
    expect(await nextIds()).toEqual([`${CODE}-T-0.3`]);
  });

  it('keeps an in-progress task in the brief even when it started early', async () => {
    await link(`${CODE}-T-0.2`, `${CODE}-T-0.1`);
    await db.task.update({ where: { humanId: `${CODE}-T-0.2` }, data: { status: 'in_progress' } });
    expect(await nextIds()).toContain(`${CODE}-T-0.2`);
  });

  it('refuses an edge to itself, to another project, or to something not a task (FRM-REQ-180)', async () => {
    const self = await link(`${CODE}-T-0.1`, `${CODE}-T-0.1`);
    expect(self.status).toBe(422);
    expect(((await self.json()) as { error: string }).error).toMatch(/itself/);

    const other = await db.project.create({
      data: { code: OTHER, name: 'Elsewhere', slug: 'dependency-elsewhere', lifecycle: 'building' },
    });
    await db.task.create({
      data: { projectId: other.id, humanId: `${OTHER}-T-1`, title: 'Somewhere else' },
    });
    const cross = await link(`${CODE}-T-0.1`, `${OTHER}-T-1`);
    expect(cross.status).toBe(422);
    expect(((await cross.json()) as { error: string }).error).toMatch(/different projects/);

    const phase = await link(`${CODE}-T-0.1`, `${CODE}-P-0`);
    expect(phase.status).toBe(422);

    expect(await db.taskDependency.count({ where: { task: { projectId } } })).toBe(0);
  });

  it('refuses an edge that closes a cycle, and names the cycle (FRM-REQ-180)', async () => {
    await link(`${CODE}-T-0.2`, `${CODE}-T-0.1`);
    await link(`${CODE}-T-0.3`, `${CODE}-T-0.2`);

    const res = await link(`${CODE}-T-0.1`, `${CODE}-T-0.3`);
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(
      `${CODE}-T-0.1 → ${CODE}-T-0.3 → ${CODE}-T-0.2 → ${CODE}-T-0.1`,
    );
    expect(await db.taskDependency.count({ where: { task: { projectId } } })).toBe(2);
  });

  it('is idempotent, and unlinking releases the task', async () => {
    const first = (await (await link(`${CODE}-T-0.2`, `${CODE}-T-0.1`)).json()) as { created: boolean };
    const again = (await (await link(`${CODE}-T-0.2`, `${CODE}-T-0.1`)).json()) as { created: boolean };
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(await db.taskDependency.count({ where: { task: { projectId } } })).toBe(1);

    expect((await link(`${CODE}-T-0.2`, `${CODE}-T-0.1`, { remove: true })).status).toBe(200);
    expect(await db.taskDependency.count({ where: { task: { projectId } } })).toBe(0);
    expect(await nextIds()).toContain(`${CODE}-T-0.2`);
  });

  it('shows both directions on a task, and the whole graph on its phase (FRM-REQ-181)', async () => {
    await link(`${CODE}-T-0.2`, `${CODE}-T-0.1`);
    await link(`${CODE}-T-0.3`, `${CODE}-T-0.1`);

    interface Edge { humanId: string; title: string; status: string }
    const scaffold = await get<{ entity: { dependsOn: Edge[]; dependedOnBy: Edge[] } }>(
      `/entities/${CODE}-T-0.1`,
    );
    expect(scaffold.entity.dependsOn).toEqual([]);
    expect(scaffold.entity.dependedOnBy.map((e) => e.humanId).sort()).toEqual([
      `${CODE}-T-0.2`,
      `${CODE}-T-0.3`,
    ]);

    const skeleton = await get<{ entity: { dependsOn: Edge[] }; backlinks: { kind: string }[] }>(
      `/entities/${CODE}-T-0.2`,
    );
    expect(skeleton.entity.dependsOn).toEqual([
      { humanId: `${CODE}-T-0.1`, title: 'Scaffold the monorepo', status: 'todo' },
    ]);

    const phase = await get<{
      entity: { tasks: { humanId: string; files: string[]; dependsOn: string[] }[] };
    }>(`/entities/${CODE}-P-0`);
    expect(phase.entity.tasks).toEqual([
      expect.objectContaining({ humanId: `${CODE}-T-0.1`, files: ['part-1/index.ts'], dependsOn: [] }),
      expect.objectContaining({ humanId: `${CODE}-T-0.2`, dependsOn: [`${CODE}-T-0.1`] }),
      expect.objectContaining({ humanId: `${CODE}-T-0.3`, dependsOn: [`${CODE}-T-0.1`] }),
    ]);
  });
});
