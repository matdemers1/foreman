import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Ideas over HTTP (FRM-REQ-153 … FRM-REQ-158).
 *
 * The shape is taken from the "Feature Ideas & Future Development" documents four projects already
 * carry — Accepted, Parked, Rejected, plus `new` for one nobody has judged — so the tests worth
 * writing are about the one rule those documents imply and a schema cannot express on its own:
 * **a parked or rejected idea must say why**, checked against the merged state rather than the
 * patch, because a request that sets only the status would otherwise leave the previous reason —
 * or none — attached to a new decision.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'ideas@example.com';
const PASSWORD = 'a-password-for-the-ideas-tests';
const CODE = 'IDEAT';

interface Idea {
  id: string;
  humanId: string;
  title: string;
  body: string | null;
  status: string;
  reason: string | null;
  decidedAt: string | null;
}

describe.skipIf(url === undefined)('ideas', () => {
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
  const create = async (body: unknown): Promise<Idea> => {
    const res = await api(`/projects/${CODE}/ideas`, { method: 'POST', body: JSON.stringify(body) });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as Idea;
  };
  const patch = (humanId: string, body: unknown) =>
    api(`/projects/${CODE}/ideas/${humanId}`, { method: 'PATCH', body: JSON.stringify(body) });
  const list = async (): Promise<Idea[]> => {
    const res = await api(`/projects/${CODE}/ideas`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: Idea[] }).items;
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
      data: { email: EMAIL, displayName: 'Ideas', status: 'active' },
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
    await api('/projects', {
      method: 'POST',
      body: JSON.stringify({ code: CODE, name: 'Ideas Test' }),
    });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  it('takes a title alone, and starts it as new', async () => {
    // A line is enough. An idea that has to be written up is a plan, and the cost of demanding a
    // description is the ideas nobody bothers to record.
    const idea = await create({ title: 'A dark mode for the console' });

    expect(idea.humanId).toBe(`${CODE}-IDEA-001`);
    expect(idea.status).toBe('new');
    expect(idea.body).toBeNull();
    expect(idea.decidedAt).toBeNull();
  });

  it('accepts one without asking why', async () => {
    const idea = await create({ title: 'Groups for projects' });
    const res = await patch(idea.humanId, { status: 'accepted' });

    expect(res.status).toBe(200);
    const updated = (await res.json()) as Idea;
    expect(updated.status).toBe('accepted');
    // Deciding stamps the date, so "when was this judged" is answerable without reading the audit.
    expect(updated.decidedAt).not.toBeNull();
  });

  for (const status of ['parked', 'rejected'] as const) {
    it(`refuses to mark one ${status} with no reason`, async () => {
      const idea = await create({ title: 'Native mobile app' });
      const res = await patch(idea.humanId, { status });

      expect(res.status).toBe(422);
      const body = (await res.json()) as { fields?: { path: string }[] };
      expect(body.fields?.[0]?.path).toBe('reason');

      // And it did not half-apply: the status is unchanged, not set with the reason missing.
      expect((await list())[0]?.status).toBe('new');
    });

    it(`takes one ${status} when it says why`, async () => {
      const idea = await create({ title: 'Native mobile app' });
      const res = await patch(idea.humanId, { status, reason: 'Desktop web only, by design.' });

      expect(res.status).toBe(200);
      expect(((await res.json()) as Idea).reason).toBe('Desktop web only, by design.');
    });
  }

  it('checks the reason against the merged state, not the patch', async () => {
    const idea = await create({ title: 'Comments on requirements' });
    await patch(idea.humanId, { status: 'parked', reason: 'After the cutover settles.' });

    // Changing only the title on an already-parked idea must not be refused for a reason it
    // already has. The naive check — "does this patch carry one" — fails exactly here.
    const res = await patch(idea.humanId, { title: 'Comments on requirements and tasks' });
    expect(res.status).toBe(200);

    // And clearing the reason on one that still needs it must be refused.
    const cleared = await patch(idea.humanId, { reason: '   ' });
    expect(cleared.status).toBe(422);
  });

  it('retires the reason when an idea is reconsidered', async () => {
    const idea = await create({ title: 'Import the other fourteen projects' });
    await patch(idea.humanId, { status: 'rejected', reason: 'Their plans are frozen.' });

    const res = await patch(idea.humanId, { status: 'new' });
    expect(res.status).toBe(200);
    const reopened = (await res.json()) as Idea;

    // Going back to `new` un-decides it. Leaving "their plans are frozen" attached to an idea
    // nobody has judged reads as a rejection that somebody forgot to finish.
    expect(reopened.reason).toBeNull();
    expect(reopened.decidedAt).toBeNull();
  });

  it('puts the unjudged first, because they are the ones that need anybody', async () => {
    const first = await create({ title: 'One' });
    await create({ title: 'Two' });
    await patch(first.humanId, { status: 'accepted' });

    const items = await list();
    expect(items.map((i) => i.status)).toEqual(['new', 'accepted']);
  });

  it('hides a deleted idea without reusing its ID', async () => {
    const idea = await create({ title: 'Something briefly considered' });
    const removed = await api(`/projects/${CODE}/ideas/${idea.humanId}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect(await list()).toEqual([]);

    const next = await create({ title: 'Something else' });
    expect(next.humanId).toBe(`${CODE}-IDEA-002`);
  });

  it('is undoable, like every other soft delete', async () => {
    const idea = await create({ title: 'Deleted by mistake' });
    await api(`/projects/${CODE}/ideas/${idea.humanId}`, { method: 'DELETE' });

    // By `entityId`, not `entityHumanId`: an audit event outlives the project cascade that
    // `beforeEach` runs, so the human ID is reused across tests while the row's UUID is not.
    const events = await db.auditEvent.findMany({
      where: { entityId: idea.id, action: 'delete' },
    });
    expect(events).toHaveLength(1);

    const res = await api(`/undo/${events[0]?.id ?? ''}`, { method: 'POST' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await list()).map((i) => i.humanId)).toEqual([idea.humanId]);
  });

  it('lists every project’s ideas at once', async () => {
    await create({ title: 'Cross-project' });

    const res = await api('/ideas');
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { items: (Idea & { project: { code: string } })[] }).items;
    const mine = items.find((i) => i.title === 'Cross-project');

    // The inbox shape: which project an idea belongs to has to survive the merge, or the list is
    // a page of titles with nowhere to act on them.
    expect(mine?.project.code).toBe(CODE);
  });

  it('finds an idea by its human ID and in search', async () => {
    const idea = await create({ title: 'A findable notion about webhooks' });

    const entity = await api(`/entities/${idea.humanId}`);
    expect(entity.status).toBe(200);
    expect(((await entity.json()) as { type: string }).type).toBe('idea');

    const found = await api('/search?q=findable%20notion&types=idea');
    expect(found.status).toBe(200);
    const hits = ((await found.json()) as { items: { humanId: string }[] }).items;
    expect(hits.map((h) => h.humanId)).toContain(idea.humanId);
  });
});
