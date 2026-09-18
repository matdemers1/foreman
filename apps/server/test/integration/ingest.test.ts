import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { buildRegistry, drainOne } from '../../src/jobs/index.js';
import { logger } from '../../src/logger.js';

/**
 * Ingest end to end (T-5.2 … T-5.8): a signed delivery becomes rows, a replay changes nothing, and
 * an attribution stays a proposal until somebody says otherwise.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'ingest@example.com';
const PASSWORD = 'a-password-for-the-ingest-tests';
const CODE = 'ING';
const SECRET = 'a-webhook-secret-for-tests';
const REPO = 'matdemers1/ingest-test';

describe.skipIf(url === undefined)('ingest', () => {
  let db: Db;
  let config: Config;
  let server: Server;
  let origin: string;
  let cookie: string;
  let registry: ReturnType<typeof buildRegistry>;

  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}/api${path}`, { ...init, headers });
  };
  const post = (path: string, body?: unknown) =>
    api(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const get = async <T>(path: string): Promise<T> => {
    const res = await api(path);
    expect(res.status, path).toBe(200);
    return (await res.json()) as T;
  };

  /** Send a delivery exactly as GitHub would: raw bytes, signed. */
  const deliver = (event: string, body: unknown, delivery: string, secret = SECRET) => {
    const raw = JSON.stringify(body);
    const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    return fetch(`${origin}/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': delivery,
        'x-hub-signature-256': signature,
      },
      body: raw,
    });
  };

  /** Run every queued job to completion, the way the worker would. */
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) {
      const outcome = await drainOne({ db, logger, registry, workerId: 'test' });
      if (outcome === null) return;
    }
    throw new Error('the queue did not drain');
  };

  const pushBody = (commits: unknown[]) => ({
    repository: { full_name: REPO },
    ref: 'refs/heads/main',
    commits,
  });

  const commit = (sha: string, message: string, files: string[] = []) => ({
    id: sha,
    message,
    timestamp: '2026-09-18T10:00:00Z',
    author: { name: 'Matthew', email: 'matthew@demers.dev' },
    added: files,
    modified: [],
    removed: [],
  });

  beforeAll(async () => {
    config = loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:3200',
      DATABASE_URL: url ?? '',
      KEK: Buffer.alloc(32, 1).toString('base64'),
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
      GITHUB_WEBHOOK_SECRET: SECRET,
    });
    db = createDb(url ?? '');
    // No GitHub client: the webhook path must not need one, and a test that quietly reached the
    // network would be a test that fails in CI for the wrong reason.
    registry = buildRegistry({ github: null });

    await db.user.deleteMany({ where: { email: EMAIL } });
    const user = await db.user.create({
      data: { email: EMAIL, displayName: 'Ingest', status: 'active' },
    });
    await setPassword({ db, config }, user.id, PASSWORD);

    server = await new Promise<Server>((resolve) => {
      const s = createApp({ config, db, registry }).listen(0, () => { resolve(s); });
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
    await db.job.deleteMany({ where: { kind: { startsWith: 'ingest' } } });
    await db.repo.deleteMany({ where: { fullName: REPO } });
    await db.project.deleteMany({ where: { code: CODE } });

    await post('/projects', { code: CODE, name: 'Ingest Test' });
    const project = await db.project.findFirstOrThrow({ where: { code: CODE } });
    await db.repo.create({ data: { projectId: project.id, fullName: REPO } });
  });

  afterAll(async () => {
    await db.repo.deleteMany({ where: { fullName: REPO } });
    await db.project.deleteMany({ where: { code: CODE } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await db.job.deleteMany({ where: { kind: { startsWith: 'ingest' } } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  describe('the webhook endpoint (T-5.2, FRM-REQ-029, FRM-REQ-100)', () => {
    it('accepts a signed delivery with 202, before doing the work', async () => {
      const res = await deliver('push', pushBody([commit('a'.repeat(40), 'A commit')]), 'd-1');

      expect(res.status).toBe(202);
      // The answer comes back before anything is stored: the job is this process's problem.
      expect(await db.commit.count({ where: { sha: 'a'.repeat(40) } })).toBe(0);

      await drain();
      expect(await db.commit.count({ where: { sha: 'a'.repeat(40) } })).toBe(1);
    });

    it('refuses an unsigned payload with 401', async () => {
      const res = await fetch(`${origin}/webhooks/github`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-github-delivery': 'd-2' },
        body: JSON.stringify(pushBody([])),
      });
      expect(res.status).toBe(401);
    });

    it('refuses a payload signed with the wrong secret', async () => {
      const res = await deliver('push', pushBody([]), 'd-3', 'not-the-secret');
      expect(res.status).toBe(401);
      // No detail about which half was wrong.
      expect(((await res.json()) as { error: string }).error).toBe('signature did not verify');
    });

    it('refuses a payload whose body was altered after signing', async () => {
      const body = JSON.stringify(pushBody([commit('b'.repeat(40), 'Honest')]));
      const signature = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

      const res = await fetch(`${origin}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': 'd-4',
          'x-hub-signature-256': signature,
        },
        body: body.replace('Honest', 'Tamper'),
      });
      expect(res.status).toBe(401);
    });

    it('ignores a pull_request event rather than handling it (FRM-REQ-099)', async () => {
      const res = await deliver('pull_request', { repository: { full_name: REPO } }, 'd-5');
      // Acknowledged — refusing would make GitHub retry forever — but nothing is enqueued.
      expect(res.status).toBe(202);
      expect(await db.job.count({ where: { idempotencyKey: 'gh:d-5' } })).toBe(0);
    });
  });

  describe('idempotency (T-5.3, FRM-REQ-101)', () => {
    it('produces no duplicate rows when a delivery is replayed', async () => {
      const body = pushBody([commit('c'.repeat(40), 'Once', ['apps/server/src/app.ts'])]);

      await deliver('push', body, 'd-replay');
      await drain();
      await deliver('push', body, 'd-replay');
      await drain();

      expect(await db.commit.count({ where: { sha: 'c'.repeat(40) } })).toBe(1);
      const stored = await db.commit.findFirstOrThrow({ where: { sha: 'c'.repeat(40) } });
      expect(await db.commitFile.count({ where: { commitId: stored.id } })).toBe(1);
      // One job, not two: the delivery id is GitHub's own idempotency key.
      expect(await db.job.count({ where: { idempotencyKey: 'gh:d-replay' } })).toBe(1);
    });

    it('stores the same commit once when two different deliveries carry it', async () => {
      // A force push and a merge both re-announce commits that are already stored.
      const c = commit('d'.repeat(40), 'Announced twice');
      await deliver('push', pushBody([c]), 'd-6');
      await drain();
      await deliver('push', pushBody([c]), 'd-7');
      await drain();

      expect(await db.commit.count({ where: { sha: 'd'.repeat(40) } })).toBe(1);
    });

    it('ingests a check run and updates its conclusion on a re-run', async () => {
      await deliver(
        'check_run',
        {
          repository: { full_name: REPO },
          check_run: { head_sha: 'e'.repeat(40), name: 'build', conclusion: 'failure' },
        },
        'd-8',
      );
      await drain();

      await deliver(
        'check_run',
        {
          repository: { full_name: REPO },
          check_run: { head_sha: 'e'.repeat(40), name: 'build', conclusion: 'success' },
        },
        'd-9',
      );
      await drain();

      const runs = await db.checkRun.findMany({ where: { commitSha: 'e'.repeat(40) } });
      expect(runs).toHaveLength(1);
      // "Is it green" means the current state of that check, not its first result.
      expect(runs[0]?.conclusion).toBe('success');
    });

    it('ingests a release', async () => {
      await deliver(
        'release',
        {
          repository: { full_name: REPO },
          release: { tag_name: 'v1.0.0', name: 'First', body: 'Notes', published_at: '2026-09-18T10:00:00Z' },
        },
        'd-10',
      );
      await drain();

      const release = await db.release.findFirstOrThrow({ where: { tag: 'v1.0.0' } });
      expect(release.name).toBe('First');
    });

    it('records why nothing happened for a repository nothing is linked to', async () => {
      await deliver('push', { repository: { full_name: 'someone/else' }, commits: [] }, 'd-11');
      await drain();

      const job = await db.job.findFirstOrThrow({
        where: { idempotencyKey: 'gh:d-11' },
        include: { stages: true },
      });
      // Not an error, and not silence: the reason is in the stage output.
      expect(job.status).toBe('succeeded');
      expect(JSON.stringify(job.stages[0]?.output)).toContain('no linked repo');
    });
  });

  describe('attribution (T-5.7, FRM-REQ-106, FRM-REQ-107)', () => {
    const makeTask = async (title: string, files: string[] = []) => {
      const res = await post(`/projects/${CODE}/tasks`, { title, ...(files.length > 0 ? { files } : {}) });
      expect(res.status).toBe(201);
      return (await res.json()) as { humanId: string; id: string };
    };

    it('proposes the task a commit message cites, in the bare form people write', async () => {
      const task = await makeTask('Guard the rule');
      const bare = task.humanId.slice(CODE.length + 1);

      await deliver('push', pushBody([commit('f'.repeat(40), `Guard the rule (${bare})`)]), 'd-12');
      await drain();

      const rows = await db.commitTask.findMany({ include: { task: true } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.task.humanId).toBe(task.humanId);
      expect(rows[0]?.source).toBe('message');
    });

    it('leaves the proposal unconfirmed (FRM-REQ-108)', async () => {
      const task = await makeTask('Still a proposal');
      await deliver(
        'push',
        pushBody([commit('1'.repeat(40), `Work (${task.humanId.slice(CODE.length + 1)})`)]),
        'd-13',
      );
      await drain();

      const row = await db.commitTask.findFirstOrThrow();
      // The whole invariant of the phase: ingest never confirms.
      expect(row.confirmed).toBe(false);
      expect(row.confirmedAt).toBeNull();
    });

    it('prefers the message over a file coincidence when both point somewhere', async () => {
      const cited = await makeTask('The cited one');
      await makeTask('The coincidence', ['apps/server/src/app.ts']);

      await deliver(
        'push',
        pushBody([
          commit('2'.repeat(40), `Real work (${cited.humanId.slice(CODE.length + 1)})`, [
            'apps/server/src/app.ts',
          ]),
        ]),
        'd-14',
      );
      await drain();

      const rows = await db.commitTask.findMany({
        include: { task: true },
        orderBy: { confidence: 'desc' },
      });
      // Both are proposed — a person may want the second — but the order is deterministic.
      expect(rows[0]?.task.humanId).toBe(cited.humanId);
      expect(rows[0]?.source).toBe('message');
      expect(rows[1]?.source).toBe('file_overlap');
      expect(Number(rows[0]?.confidence)).toBeGreaterThan(Number(rows[1]?.confidence));
    });

    it('proposes nothing when the message cites a task that does not exist', async () => {
      await deliver('push', pushBody([commit('3'.repeat(40), 'Fixes T-99.99')]), 'd-15');
      await drain();

      // A typo in a commit message is not a reason to invent a link.
      expect(await db.commitTask.count()).toBe(0);
    });

    it('proposes the tasks satisfying a cited requirement, more weakly', async () => {
      const requirement = await post(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall be satisfied by a task.',
      });
      const { id, humanId } = (await requirement.json()) as { id: string; humanId: string };
      await post(`/projects/${CODE}/tasks`, { title: 'Satisfies it', requirementIds: [id] });

      await deliver(
        'push',
        pushBody([commit('4'.repeat(40), `Work toward ${humanId.slice(CODE.length + 1)}`)]),
        'd-16',
      );
      await drain();

      const row = await db.commitTask.findFirstOrThrow();
      expect(row.source).toBe('message');
      // Below a direct task citation: the commit named the why, and the task is inferred from it.
      expect(Number(row.confidence)).toBeLessThan(0.9);
    });
  });

  describe('confirming and rejecting (T-5.9, FRM-REQ-109)', () => {
    const proposeOne = async () => {
      const created = await post(`/projects/${CODE}/tasks`, { title: 'To be confirmed' });
      const task = (await created.json()) as { humanId: string };
      await deliver(
        'push',
        pushBody([commit('5'.repeat(40), `Done (${task.humanId.slice(CODE.length + 1)})`)]),
        `d-confirm-${task.humanId}`,
      );
      await drain();
      return task;
    };

    it('confirms from the console', async () => {
      const task = await proposeOne();
      const res = await post(`/projects/${CODE}/attributions/${'5'.repeat(40)}/confirm`, {
        task: task.humanId,
      });
      expect(res.status).toBe(200);

      const row = await db.commitTask.findFirstOrThrow();
      expect(row.confirmed).toBe(true);
      expect(row.confirmedBy).toBe(EMAIL);
    });

    it('rejects, and the rejection survives the next reconcile', async () => {
      const task = await proposeOne();
      await post(`/projects/${CODE}/attributions/${'5'.repeat(40)}/reject`, { task: task.humanId });

      // Re-delivering the same push must not re-offer what somebody already turned down.
      await deliver(
        'push',
        pushBody([commit('5'.repeat(40), `Done (${task.humanId.slice(CODE.length + 1)})`)]),
        'd-after-reject',
      );
      await drain();

      const row = await db.commitTask.findFirstOrThrow();
      expect(row.confirmed).toBe(false);
      expect(row.rejectedAt).not.toBeNull();
    });

    it('accepts a short SHA, because that is what anybody has to hand', async () => {
      const task = await proposeOne();
      const res = await post(`/projects/${CODE}/attributions/${'5'.repeat(12)}/confirm`, {
        task: task.humanId,
      });
      expect(res.status).toBe(200);
    });
  });

  describe('what is unattributed (T-5.10, FRM-REQ-110)', () => {
    it('lists commits nothing has been proposed for', async () => {
      await deliver(
        'push',
        pushBody([
          commit('6'.repeat(40), 'A commit citing nothing at all'),
          commit('7'.repeat(40), 'Another one'),
        ]),
        'd-17',
      );
      await drain();

      const listed = await get<{ items: { sha: string; message: string }[]; total: number }>(
        `/projects/${CODE}/commits?attributed=none`,
      );
      // The coverage gap is the point: roughly half of every real corpus looks like this, and a
      // number nobody can see is a number nobody acts on (R-02).
      expect(listed.total).toBe(2);
      expect(listed.items.map((c) => c.sha.slice(0, 1)).sort()).toEqual(['6', '7']);
    });
  });
});
