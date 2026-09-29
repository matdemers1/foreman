import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Guidelines over HTTP (FRM-REQ-186 … FRM-REQ-188).
 *
 * The standing decisions for every project. What these assert is the reason the entity exists:
 * an active guideline reaches every brief and the portfolio without anybody asking for it, and a
 * retired one reaches none of them.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'guidelines@example.com';
const PASSWORD = 'a-password-for-the-guideline-tests';
const CODE = 'GLT';

interface Guideline {
  id: string;
  humanId: string;
  title: string;
  area: string;
  decision: string;
  rationale: string | null;
  guidance: string | null;
  status: string;
}

describe.skipIf(url === undefined)('guidelines', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;

  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}${path}`, { ...init, headers });
  };
  const create = async (body: unknown): Promise<Guideline> => {
    const res = await api('/api/guidelines', { method: 'POST', body: JSON.stringify(body) });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as Guideline;
  };
  const patch = async (humanId: string, body: unknown): Promise<Guideline> => {
    const res = await api(`/api/guidelines/${humanId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Guideline;
  };
  const briefGuidelines = async () => {
    const res = await api(`/api/brief/${CODE}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { guidelines: { humanId: string; decision: string }[] })
      .guidelines;
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
      data: { email: EMAIL, displayName: 'Guidelines', status: 'active' },
    });
    await setPassword({ db, config }, user.id, PASSWORD);
    await db.project.deleteMany({ where: { code: CODE } });
    await db.project.create({ data: { code: CODE, name: 'Guideline test project', slug: 'guideline-test' } });

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
    // By title prefix: a guideline belongs to no project, so nothing cascades to it. The sequence
    // is deliberately not reset — a number is never reused.
    await db.guideline.deleteMany({ where: { title: { startsWith: 'GLT ' } } });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  it('takes one with no project, gives it a codeless ID, and records it', async () => {
    const created = await create({
      title: 'GLT both logins',
      area: 'Architecture',
      decision: 'Every app gets app-native login and Sign in with D3 Auth.',
      rationale: 'Either can fail; neither can lock you out alone.',
    });

    expect(created.humanId).toMatch(/^GL-\d{3,}$/);
    expect(created.status).toBe('active');
    expect(created.guidance).toBeNull();

    const events = await db.auditEvent.findMany({
      where: { entityId: created.id, action: 'create', entityType: 'guideline' },
    });
    expect(events).toHaveLength(1);
  });

  it('refuses one without a decision', async () => {
    const res = await api('/api/guidelines', {
      method: 'POST',
      body: JSON.stringify({ title: 'GLT nothing decided', area: 'Process' }),
    });
    expect(res.status).toBe(400);
  });

  it('edits, and clears an optional section with an empty string', async () => {
    const created = await create({
      title: 'GLT tokens only',
      area: 'Design',
      decision: 'No raw hex in any console.',
      guidance: 'Run d3-check-usage.',
    });
    const edited = await patch(created.humanId, { decision: 'Tokens only.', guidance: '' });

    expect(edited.decision).toBe('Tokens only.');
    // Null, not '': an empty section is not a written one.
    expect(edited.guidance).toBeNull();
  });

  it('puts active guidelines in every brief and the portfolio, and retired ones in neither', async () => {
    const kept = await create({ title: 'GLT kept', area: 'Process', decision: 'Kept rule.' });
    const retired = await create({ title: 'GLT dropped', area: 'Process', decision: 'Old rule.' });
    await patch(retired.humanId, { status: 'retired' });

    const inBrief = (await briefGuidelines()).map((g) => g.humanId);
    expect(inBrief).toContain(kept.humanId);
    expect(inBrief).not.toContain(retired.humanId);

    const portfolio = (await (await api('/api/portfolio')).json()) as {
      guidelines: { humanId: string }[];
    };
    const inPortfolio = portfolio.guidelines.map((g) => g.humanId);
    expect(inPortfolio).toContain(kept.humanId);
    expect(inPortfolio).not.toContain(retired.humanId);

    // The list itself keeps both: retiring is a status, not a disappearance.
    const all = (await (await api('/api/guidelines')).json()) as { items: Guideline[] };
    expect(all.items.map((g) => g.humanId)).toEqual(
      expect.arrayContaining([kept.humanId, retired.humanId]),
    );
  });

  it('is found by its ID, and is undoable when deleted', async () => {
    const created = await create({ title: 'GLT findable', area: 'Process', decision: 'Find me.' });

    const entity = await api(`/api/entities/${created.humanId}`);
    expect(entity.status).toBe(200);
    const resolved = (await entity.json()) as { type: string; projectCode: string | null };
    expect(resolved.type).toBe('guideline');
    expect(resolved.projectCode).toBeNull();

    expect((await api(`/api/guidelines/${created.humanId}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(`/api/guidelines/${created.humanId}`)).status).toBe(404);
    expect((await briefGuidelines()).map((g) => g.humanId)).not.toContain(created.humanId);

    const events = await db.auditEvent.findMany({
      where: { entityId: created.id, action: 'delete' },
    });
    expect(events).toHaveLength(1);
    const undone = await api(`/api/undo/${events[0]?.id ?? ''}`, { method: 'POST' });
    expect(undone.status, await undone.clone().text()).toBe(200);
    expect((await api(`/api/guidelines/${created.humanId}`)).status).toBe(200);
  });

  it('renders the active ones as one Markdown page, headed by ID', async () => {
    const created = await create({
      title: 'GLT markdown',
      area: 'Zeta area',
      decision: 'Shown in the page.',
      guidance: '- one\n- two',
    });
    const res = await api('/api/guidelines/markdown');
    const { markdown } = (await res.json()) as { markdown: string };

    expect(markdown).toContain('## Zeta area');
    expect(markdown).toContain(`### ${created.humanId} — GLT markdown`);
    expect(markdown).toContain('**Decision.** Shown in the page.');
    expect(markdown).toContain('- one\n- two');
  });
});
