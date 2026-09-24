import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * The human-ID allocator against rows it did not write (FRM-REQ-044, FRM-REQ-045, ADR-008).
 *
 * The counter on `project.id_counters` is the fast path, and until now it was the only path. That
 * held exactly as long as every row came through the API. **The P10 importer did not** — it writes
 * human IDs directly, and it never seeded the counters, so all nine imported projects sat on `{}`
 * with hundreds of rows. The first ADR created through the API in any of them allocated
 * `FRM-ADR-001`, collided with the imported row on the unique index, and came back as
 * `internal error`.
 *
 * Nothing pointed at the cause. The counter was not corrupt and the data was not corrupt; they
 * simply disagreed, and no code read both. So these tests set up that disagreement deliberately —
 * rows written behind the allocator's back, which is also what a restored partial dump looks like —
 * and assert the allocator reconciles rather than collides.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'human-id@example.com';
const PASSWORD = 'a-password-for-the-allocator-tests';
const CODE = 'HID';

describe.skipIf(url === undefined)('allocating a human ID', () => {
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
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await api(path, { method: 'POST', body: JSON.stringify(body) });
    expect(res.status, `${path} → ${await res.clone().text()}`).toBe(201);
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
      data: { email: EMAIL, displayName: 'Allocator', status: 'active' },
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
    const project = await post<{ id: string }>('/projects', { code: CODE, name: 'Allocator Test' });
    projectId = project.id;
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  /** What the importer does: rows with human IDs, and a counter left where it started. */
  const importAdrs = async (count: number) => {
    for (let n = 1; n <= count; n += 1) {
      await db.adr.create({
        data: {
          projectId,
          humanId: `${CODE}-ADR-${String(n).padStart(3, '0')}`,
          number: n,
          title: `Imported ${String(n)}`,
        },
      });
    }
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.idCounters, 'the importer leaves the counter untouched').toEqual({});
  };

  it('does not hand out an ID that an import already used', async () => {
    await importAdrs(13);

    const adr = await post<{ humanId: string }>(`/projects/${CODE}/adrs`, { title: 'The next one' });

    // The bug in one assertion: before the allocator read the rows, this was `HID-ADR-001` and the
    // insert failed on the unique index.
    expect(adr.humanId).toBe(`${CODE}-ADR-014`);
  });

  it('keeps counting from there without re-reading the rows', async () => {
    await importAdrs(13);

    const first = await post<{ humanId: string }>(`/projects/${CODE}/adrs`, { title: 'One' });
    const second = await post<{ humanId: string }>(`/projects/${CODE}/adrs`, { title: 'Two' });

    // The heal raises the floor; it does not become the mechanism. The counter is authoritative
    // again the moment it is ahead, which is what keeps an ID from being reused after a delete.
    expect([first.humanId, second.humanId]).toEqual([`${CODE}-ADR-014`, `${CODE}-ADR-015`]);
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.idCounters).toMatchObject({ ADR: 15 });
  });

  it('never reuses the number of a deleted row', async () => {
    await importAdrs(13);
    const created = await post<{ id: string; humanId: string }>(`/projects/${CODE}/adrs`, {
      title: 'Short-lived',
    });
    expect(created.humanId).toBe(`${CODE}-ADR-014`);

    await db.adr.update({ where: { id: created.id }, data: { deletedAt: new Date() } });
    const next = await post<{ humanId: string }>(`/projects/${CODE}/adrs`, { title: 'After' });

    // A soft delete does not free the number — every citation of `HID-ADR-014` would otherwise
    // start pointing at something else. Both paths have to agree on this: the counter because it
    // only moves forward, and the high-water mark because it ignores `deleted_at`.
    expect(next.humanId).toBe(`${CODE}-ADR-015`);
  });

  it('separates the four finding prefixes that share one table', async () => {
    // `CR`, `DA`, `FR` and `API` are four counters over the same rows. A high-water mark that
    // matched on the table alone would let a code-review finding push the design counter along.
    const audit = await post<{ id: string }>(`/projects/${CODE}/audits`, {
      kind: 'code_review',
      scope: 'the allocator',
      runDate: '2026-09-20',
    });
    await db.finding.create({
      data: {
        projectId,
        auditId: audit.id,
        humanId: `${CODE}-DA-009`,
        title: 'An imported design finding',
        severity: 'low',
      },
    });

    const finding = await post<{ humanId: string }>(`/projects/${CODE}/findings`, {
      auditId: audit.id,
      title: 'A fresh code-review finding',
      severity: 'low',
    });

    expect(finding.humanId).toBe(`${CODE}-CR-001`);
  });

  it('ignores a dotted task ID, which cannot collide with a counter one', async () => {
    // A task takes its ID from its phase when it has one — `HID-T-8.3` — and from the counter when
    // it does not. Letting `8.3` raise the floor would start the unassigned tasks at 9 because some
    // phase 8 happened to have three of them.
    const phase = await post<{ id: string }>(`/projects/${CODE}/phases`, {
      name: 'Phase eight',
      number: 8,
    });
    const phased = await post<{ humanId: string }>(`/projects/${CODE}/tasks`, {
      title: 'In the phase',
      phaseId: phase.id,
    });
    expect(phased.humanId).toBe(`${CODE}-T-8.1`);

    const loose = await post<{ humanId: string }>(`/projects/${CODE}/tasks`, {
      title: 'No phase at all',
    });

    expect(loose.humanId).toBe(`${CODE}-T-001`);
  });

  describe('a task in a phase', () => {
    const phase = (number: number) =>
      post<{ id: string; humanId: string }>(`/projects/${CODE}/phases`, {
        name: `Phase ${String(number)}`,
        number,
      });
    const task = (title: string, phaseId: string) =>
      post<{ humanId: string }>(`/projects/${CODE}/tasks`, { title, phaseId });

    it('gets a fresh ID after a task has moved out of the phase', async () => {
      // DI on 2026-09-24: P-0 held 36 tasks, so the next was given `DI-T-0.37` — which belonged to a
      // task already moved to P-1. The unique index refused it and the API said `internal error`.
      const p0 = await phase(0);
      const p1 = await phase(1);
      await task('One', p0.id);
      const moving = await task('Two', p0.id);
      await task('Three', p0.id);

      const moved = await api(`/projects/${CODE}/tasks/${moving.humanId}`, {
        method: 'PATCH',
        body: JSON.stringify({ phaseId: p1.id }),
      });
      expect(moved.status).toBe(200);

      // Two tasks left in P-0, so a count says 3 — which is taken.
      const next = await task('Four', p0.id);
      expect(next.humanId).toBe(`${CODE}-T-0.4`);
    });

    it('never reuses the number of a deleted task in the phase', async () => {
      const p0 = await phase(0);
      await task('One', p0.id);
      const doomed = await task('Two', p0.id);
      const gone = await api(`/projects/${CODE}/tasks/${doomed.humanId}`, { method: 'DELETE' });
      expect(gone.status).toBe(204);

      const next = await task('Three', p0.id);
      expect(next.humanId).toBe(`${CODE}-T-0.3`);
    });

    it('does not count phase 1.5 as phase 1', async () => {
      const p1 = await phase(1);
      const p15 = await phase(1.5);
      await task('In 1.5', p15.id);
      await task('Also in 1.5', p15.id);

      expect((await task('In 1', p1.id)).humanId).toBe(`${CODE}-T-1.1`);
    });

    it('takes distinct IDs when created at the same moment', async () => {
      const p0 = await phase(0);
      const ids = await Promise.all(
        Array.from({ length: 6 }, (_, i) => task(`Concurrent ${String(i)}`, p0.id)),
      );
      expect(new Set(ids.map((t) => t.humanId)).size).toBe(6);
    });

    it('answers a unique violation with 409, not 500', async () => {
      // An allocator should never hand out a taken ID, but when one does, the answer is a conflict
      // the caller can read, not `internal error`. A soft-deleted phase still holds `HID-P-0`
      // (ADR-008), and the up-front clash check only looks at live ones — so this reaches the index.
      const p0 = await phase(0);
      await db.phase.update({ where: { id: p0.id }, data: { deletedAt: new Date() } });

      const dup = await api(`/projects/${CODE}/phases`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Same ID as a deleted phase', number: 0 }),
      });
      expect(dup.status).toBe(409);
      expect(await dup.json()).toEqual({ error: 'that would duplicate an existing record' });
    });
  });

  describe('what foreman_create addresses by human ID', () => {
    it('files a task under ?phase= and cites ?satisfies=', async () => {
      const p3 = await post<{ humanId: string }>(`/projects/${CODE}/phases`, {
        name: 'Phase three',
        number: 3,
      });
      const a = await post<{ humanId: string }>(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall do a thing.',
      });
      const b = await post<{ humanId: string }>(`/projects/${CODE}/requirements`, {
        statement: 'Foreman shall do another thing.',
      });

      const created = await post<{ humanId: string; requirements: unknown[] }>(
        `/projects/${CODE}/tasks?phase=${p3.humanId}&satisfies=${a.humanId},${b.humanId}`,
        { title: 'From MCP' },
      );
      expect(created.humanId).toBe(`${CODE}-T-3.1`);
      expect(created.requirements).toHaveLength(2);
    });

    it('files a requirement under ?phase=', async () => {
      const p3 = await post<{ id: string; humanId: string }>(`/projects/${CODE}/phases`, {
        name: 'Phase three',
        number: 3,
      });
      const created = await post<{ phaseId: string | null }>(
        `/projects/${CODE}/requirements?phase=${p3.humanId}`,
        { statement: 'Foreman shall be filed.' },
      );
      expect(created.phaseId).toBe(p3.id);
    });

    it('refuses an ID it cannot resolve, by name, rather than dropping it', async () => {
      const res = await api(`/projects/${CODE}/tasks?satisfies=${CODE}-REQ-404`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Cites nothing real' }),
      });
      expect(res.status).toBe(422);
      expect(JSON.stringify(await res.json())).toContain(`${CODE}-REQ-404`);

      const noPhase = await api(`/projects/${CODE}/tasks?phase=${CODE}-P-9`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Nowhere' }),
      });
      expect(noPhase.status).toBe(422);
    });
  });
});
