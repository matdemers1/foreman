import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Project ideas over HTTP (FRM-REQ-159 … FRM-REQ-164, FRM-ADR-015).
 *
 * The one record in Foreman that belongs to no project, which is what most of these assert. Its
 * ID has no code, its path has no code, and the code it will eventually have is asked for exactly
 * once — at conversion, which is the first moment anybody could answer the question.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'project-ideas@example.com';
const PASSWORD = 'a-password-for-the-project-idea-tests';
/** Codes this suite creates by converting. Cleaned up by code, since it invents them. */
const CODES = ['PITA', 'PITB', 'PITC'];

interface Idea {
  id: string;
  humanId: string;
  title: string;
  pitch: string | null;
  status: string;
  reason: string | null;
  convertedAt: string | null;
  project: { code: string; name: string } | null;
}

describe.skipIf(url === undefined)('project ideas', () => {
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
    const res = await api('/project-ideas', { method: 'POST', body: JSON.stringify(body) });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as Idea;
  };
  const patch = (humanId: string, body: unknown) =>
    api(`/project-ideas/${humanId}`, { method: 'PATCH', body: JSON.stringify(body) });
  const convert = (humanId: string, body: unknown) =>
    api(`/project-ideas/${humanId}/convert`, { method: 'POST', body: JSON.stringify(body) });

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
      data: { email: EMAIL, displayName: 'Project ideas', status: 'active' },
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

  afterEach(async () => {
    // By title prefix: these are ecosystem-wide with no project to cascade from, so nothing else
    // cleans them up. The sequence is deliberately *not* reset — a number is never reused.
    await db.projectIdea.deleteMany({ where: { title: { startsWith: 'PIT ' } } });
    await db.project.deleteMany({ where: { code: { in: CODES } } });
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  it('takes one with no project, and gives it a codeless ID', async () => {
    const idea = await create({ title: 'PIT a print notifier', pitch: 'Texts you when it stops.' });

    // The assertion the whole entity exists for: no project code, because there is no project.
    expect(idea.humanId).toMatch(/^PI-\d{3,}$/);
    expect(idea.project).toBeNull();
    expect(idea.status).toBe('new');
  });

  it('numbers them from a sequence that never goes backwards', async () => {
    const first = await create({ title: 'PIT one' });
    const second = await create({ title: 'PIT two' });

    const seqOf = (humanId: string) => Number(humanId.slice('PI-'.length));
    expect(seqOf(second.humanId)).toBe(seqOf(first.humanId) + 1);

    // Deleting the newest does not hand its number back. Every citation of `PI-007` would
    // otherwise start pointing at a different idea (ADR-008).
    await api(`/project-ideas/${second.humanId}`, { method: 'DELETE' });
    const third = await create({ title: 'PIT three' });
    expect(seqOf(third.humanId)).toBe(seqOf(second.humanId) + 1);
  });

  for (const status of ['parked', 'rejected'] as const) {
    it(`refuses ${status} with no reason, and takes it with one`, async () => {
      const idea = await create({ title: 'PIT a second chat client' });

      const bare = await patch(idea.humanId, { status });
      expect(bare.status).toBe(422);
      expect(((await bare.json()) as { fields?: { path: string }[] }).fields?.[0]?.path).toBe(
        'reason',
      );

      const withReason = await patch(idea.humanId, { status, reason: 'D3 Chat already exists.' });
      expect(withReason.status).toBe(200);
      expect(((await withReason.json()) as Idea).reason).toBe('D3 Chat already exists.');
    });
  }

  it('will not let a PATCH claim it was converted', async () => {
    const idea = await create({ title: 'PIT a status page' });

    // `converted` means a project exists. A patch that could set it would produce an idea saying
    // it became something, pointing at nothing — a lie the screen would render as a dead link.
    // 400, not 422: the schema refuses it outright rather than the domain weighing it, which is
    // the stronger of the two — the value is not in the enum the surface accepts at all.
    const res = await patch(idea.humanId, { status: 'converted' });
    expect(res.status).toBe(400);
  });

  it('converts into a project, carrying the pitch across', async () => {
    const idea = await create({
      title: 'PIT a print notifier',
      pitch: 'MQTT on the LAN, the cloud as a fallback.',
    });

    const res = await convert(idea.humanId, { code: 'PITA', name: 'Bambu Print Notifier' });
    expect(res.status, await res.clone().text()).toBe(201);
    const { idea: converted, project } = (await res.json()) as {
      idea: Idea;
      project: { code: string; name: string; pitch: string | null; lifecycle: string };
    };

    expect(project.code).toBe('PITA');
    expect(project.name).toBe('Bambu Print Notifier');
    // The pitch is the reason to write more than a line on an idea: it has somewhere to go.
    expect(project.pitch).toBe('MQTT on the LAN, the cloud as a fallback.');
    expect(project.lifecycle).toBe('planned');

    // And the idea is kept, not consumed. It is the record of where the project came from, which
    // is the one piece of a project's history nothing else writes down.
    expect(converted.status).toBe('converted');
    expect(converted.convertedAt).not.toBeNull();
    expect(converted.project?.code).toBe('PITA');
  });

  it('names the project after the idea when no name is given', async () => {
    const idea = await create({ title: 'PIT an offline notebook' });
    const res = await convert(idea.humanId, { code: 'PITB' });

    expect(res.status).toBe(201);
    const { project } = (await res.json()) as { project: { name: string } };
    expect(project.name).toBe('PIT an offline notebook');
  });

  it('leaves the idea untouched when the code is already taken', async () => {
    await db.project.create({ data: { code: 'PITC', name: 'Already here', slug: 'already-here' } });
    const idea = await create({ title: 'PIT a clash' });

    const res = await convert(idea.humanId, { code: 'PITC' });
    expect(res.status).toBe(409);

    // Half-converted is the failure worth guarding: an idea marked `converted` whose project was
    // never created would be unfixable through any surface, because converting is then refused.
    const after = (await (await api(`/project-ideas/${idea.humanId}`)).json()) as Idea;
    expect(after.status).toBe('new');
    expect(after.project).toBeNull();
  });

  it('refuses to convert the same idea twice', async () => {
    const idea = await create({ title: 'PIT a print notifier' });
    expect((await convert(idea.humanId, { code: 'PITA' })).status).toBe(201);
    expect((await convert(idea.humanId, { code: 'PITB' })).status).toBe(409);
  });

  it('freezes a converted idea, because a project now says what it says', async () => {
    const idea = await create({ title: 'PIT a print notifier' });
    await convert(idea.humanId, { code: 'PITA' });

    const res = await patch(idea.humanId, { title: 'PIT something else entirely' });
    expect(res.status).toBe(409);
  });

  it('refuses `PI` as a project code', async () => {
    // Otherwise `PI-REQ-001` and `PI-001` mean two different things one character apart.
    const res = await api('/projects', {
      method: 'POST',
      body: JSON.stringify({ code: 'PI', name: 'Reserved' }),
    });
    expect(res.status).toBe(400);
  });

  it('is found by its ID and in search, and is undoable when deleted', async () => {
    const idea = await create({ title: 'PIT a findable notion', pitch: 'About webhooks.' });

    const entity = await api(`/entities/${idea.humanId}`);
    expect(entity.status).toBe(200);
    const resolved = (await entity.json()) as { type: string; projectCode: string | null };
    expect(resolved.type).toBe('project_idea');
    // Null rather than absent: the field means "which project", and the answer is "none".
    expect(resolved.projectCode).toBeNull();

    const found = await api('/search?q=findable%20notion&types=project_idea');
    const hits = ((await found.json()) as { items: { humanId: string }[] }).items;
    expect(hits.map((h) => h.humanId)).toContain(idea.humanId);

    await api(`/project-ideas/${idea.humanId}`, { method: 'DELETE' });
    const events = await db.auditEvent.findMany({
      where: { entityId: idea.id, action: 'delete' },
    });
    expect(events).toHaveLength(1);

    const undone = await api(`/undo/${events[0]?.id ?? ''}`, { method: 'POST' });
    expect(undone.status, await undone.clone().text()).toBe(200);
    expect((await api(`/project-ideas/${idea.humanId}`)).status).toBe(200);
  });
});
