import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * A recorded deployment cites the tasks it shipped (FRM-T-006, SHP-REQ-088).
 *
 * Shipyard tells Foreman what a successful deploy shipped by citing task IDs on the deployment it
 * records. The assertions that matter: linking is idempotent, a foreign-project ID is ignored
 * rather than rejected, and a task's own read shows where it was deployed, newest first.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'deploytasks@example.com';
const PASSWORD = 'a-password-for-the-deployment-task-tests';
const CODE = 'DPT';
const OTHER = 'DPTX';

interface DeploymentResponse {
  id: string;
  environment: string;
  imageSha: string;
  tasks: string[];
}

interface TaskEntity {
  entity: {
    deployments: {
      environment: string;
      imageSha: string;
      schemaRevision: string | null;
      deployedAt: string;
    }[];
  };
}

describe.skipIf(url === undefined)('deployment tasks', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;
  let projectId: string;

  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}/api${path}`, { ...init, headers });
  };
  const deploy = (body: Record<string, unknown>) =>
    api(`/projects/${CODE}/deployments`, { method: 'POST', body: JSON.stringify(body) });
  const get = async <T>(path: string): Promise<T> => {
    const res = await api(path);
    expect(res.status, path).toBe(200);
    return (await res.json()) as T;
  };

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
      data: { email: EMAIL, displayName: 'Deploy Tasks', status: 'active' },
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
    await db.project.deleteMany({ where: { code: { in: [CODE, OTHER] } } });
    const project = await db.project.create({
      data: { code: CODE, name: 'Deployment Task Test', slug: 'deployment-task-test', lifecycle: 'building' },
    });
    projectId = project.id;

    await db.task.create({
      data: { projectId, humanId: `${CODE}-T-1`, title: 'Ship the button' },
    });
    await db.task.create({
      data: { projectId, humanId: `${CODE}-T-2`, title: 'Wire the audit trail' },
    });
    await db.task.create({
      data: { projectId, humanId: `${CODE}-T-3`, title: 'Deleted before it shipped', deletedAt: new Date() },
    });

    const other = await db.project.create({
      data: { code: OTHER, name: 'Elsewhere', slug: 'deployment-task-elsewhere', lifecycle: 'building' },
    });
    await db.task.create({ data: { projectId: other.id, humanId: `${OTHER}-T-1`, title: 'Somewhere else' } });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: { in: [CODE, OTHER] } } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await db.$disconnect();
  });

  it('links task IDs that resolve, ignores the rest, and reports what linked (FRM-T-006)', async () => {
    const res = await deploy({
      environment: 'prod',
      image: 'ghcr.io/example/app:sha-abc123',
      imageSha: 'sha256:' + 'a'.repeat(64),
      schemaRevision: '20260925000000_init',
      tasks: [`${CODE}-T-1`, `${CODE}-T-2`, `${CODE}-T-3`, `${OTHER}-T-1`, `${CODE}-T-999`, 'not-an-id'],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as DeploymentResponse;
    // Live tasks in this project only: T-3 is soft-deleted, the foreign and unknown IDs are ignored.
    expect(body.tasks.sort()).toEqual([`${CODE}-T-1`, `${CODE}-T-2`]);

    const links = await db.deploymentTask.count({ where: { deploymentId: body.id } });
    expect(links).toBe(2);
  });

  it('is idempotent: one link per task per deployment even if an ID repeats', async () => {
    const res = await deploy({
      environment: 'prod',
      image: 'ghcr.io/example/app:sha-abc123',
      imageSha: 'sha256:' + 'b'.repeat(64),
      tasks: [`${CODE}-T-1`, `${CODE}-T-1`],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as DeploymentResponse;
    expect(body.tasks).toEqual([`${CODE}-T-1`]);
    expect(await db.deploymentTask.count({ where: { deploymentId: body.id } })).toBe(1);
  });

  it('lists no linked tasks when none are given', async () => {
    const res = await deploy({
      environment: 'staging',
      image: 'ghcr.io/example/app:sha-def456',
      imageSha: 'sha256:' + 'c'.repeat(64),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as DeploymentResponse;
    expect(body.tasks).toEqual([]);
  });

  it("shows a task's deployments newest first, on the REST read and via foreman_get's entity endpoint", async () => {
    const first = await deploy({
      environment: 'prod',
      image: 'ghcr.io/example/app:sha-1',
      imageSha: 'sha256:' + '1'.repeat(64),
      schemaRevision: 'rev-1',
      deployedAt: '2026-09-20T00:00:00Z',
      tasks: [`${CODE}-T-1`],
    });
    expect(first.status).toBe(201);

    const second = await deploy({
      environment: 'prod',
      image: 'ghcr.io/example/app:sha-2',
      imageSha: 'sha256:' + '2'.repeat(64),
      schemaRevision: 'rev-2',
      deployedAt: '2026-09-24T00:00:00Z',
      tasks: [`${CODE}-T-1`, `${CODE}-T-2`],
    });
    expect(second.status).toBe(201);

    const task = await get<TaskEntity>(`/entities/${CODE}-T-1`);
    expect(task.entity.deployments).toEqual([
      { environment: 'prod', imageSha: 'sha256:' + '2'.repeat(64), schemaRevision: 'rev-2', deployedAt: '2026-09-24T00:00:00.000Z' },
      { environment: 'prod', imageSha: 'sha256:' + '1'.repeat(64), schemaRevision: 'rev-1', deployedAt: '2026-09-20T00:00:00.000Z' },
    ]);

    const other = await get<TaskEntity>(`/entities/${CODE}-T-2`);
    expect(other.entity.deployments).toEqual([
      { environment: 'prod', imageSha: 'sha256:' + '2'.repeat(64), schemaRevision: 'rev-2', deployedAt: '2026-09-24T00:00:00.000Z' },
    ]);
  });
});
