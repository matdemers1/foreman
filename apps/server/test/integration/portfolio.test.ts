import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { PortfolioRow } from '../../src/domain/portfolio.js';
import type { SearchHit } from '../../src/domain/search.js';

/**
 * The portfolio and typed search (T-1.8) — "where is everything", and "where is that thing I
 * remember".
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'portfolio@example.com';
const PASSWORD = 'a-password-for-the-portfolio-tests';
const CODES = ['PFA', 'PFB'];

describe.skipIf(url === undefined)('portfolio and search', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;

  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${origin}/api${path}`, { headers: { cookie } });
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

    await db.project.deleteMany({ where: { code: { in: CODES } } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    const user = await db.user.create({
      data: { email: EMAIL, displayName: 'Portfolio', status: 'active' },
    });
    await setPassword({ db, config }, user.id, PASSWORD);

    // PFA: mid-flight, with an active phase, a critical, CI, and a coverage hole.
    const a = await db.project.create({
      data: { code: 'PFA', name: 'Alpha', slug: 'alpha', lifecycle: 'building' },
    });
    const phase = await db.phase.create({
      data: {
        projectId: a.id,
        humanId: 'PFA-P-2',
        number: 2,
        sortOrder: 2,
        name: 'Ingest',
        status: 'active',
        objective: 'Take GitHub reality in through a webhook.',
      },
    });
    await db.task.createMany({
      data: [
        { projectId: a.id, phaseId: phase.id, humanId: 'PFA-T-2.1', title: 'Receive the webhook', status: 'done' },
        { projectId: a.id, phaseId: phase.id, humanId: 'PFA-T-2.2', title: 'Verify the HMAC signature', status: 'todo' },
        {
          projectId: a.id,
          phaseId: phase.id,
          humanId: 'PFA-T-2.3',
          title: 'Backfill old commits',
          status: 'blocked',
          blockedReason: 'The App is not installed on the repo yet.',
        },
      ],
    });
    await db.requirement.createMany({
      data: [
        { projectId: a.id, humanId: 'PFA-REQ-001', seq: 1, statement: 'Foreman shall verify the HMAC signature of every webhook.' },
        { projectId: a.id, humanId: 'PFA-REQ-002', seq: 2, statement: 'Foreman shall use pg_trgm for fuzzy matching.' },
      ],
    });
    await db.finding.create({
      data: {
        projectId: a.id,
        humanId: 'PFA-CR-001',
        title: 'The webhook accepts an unsigned payload',
        severity: 'critical',
        status: 'open',
        observedMd: 'A request with no signature header is processed as though it were signed.',
      },
    });
    await db.adr.create({
      data: {
        projectId: a.id,
        humanId: 'PFA-ADR-001',
        number: 1,
        title: 'Search uses pg_trgm rather than a search engine',
        status: 'accepted',
        decisionAbstract: 'Trigram indexes in the database we already run, not a second service.',
      },
    });
    const repo = await db.repo.create({ data: { projectId: a.id, fullName: 'test/alpha' } });
    await db.checkRun.create({
      data: {
        repoId: repo.id,
        commitSha: 'a'.repeat(40),
        name: 'ci',
        conclusion: 'failure',
        completedAt: new Date(),
      },
    });
    await db.commit.create({
      data: {
        repoId: repo.id,
        sha: 'b'.repeat(40),
        message: 'Verify the signature',
        author: 'tester',
        committedAt: new Date(),
      },
    });

    // PFB: planned, and nothing has ever been ingested for it.
    await db.project.create({
      data: { code: 'PFB', name: 'Beta', slug: 'beta', lifecycle: 'planned' },
    });

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

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: { in: CODES } } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  describe('the portfolio (FRM-REQ-133)', () => {
    it('populates every column for a project mid-flight', async () => {
      const { items } = await get<{ items: PortfolioRow[] }>('/portfolio');
      const alpha = items.find((row) => row.code === 'PFA');

      expect(alpha?.lifecycle).toBe('building');
      expect(alpha?.phase?.humanId).toBe('PFA-P-2');
      expect(alpha?.tasks).toEqual({ open: 1, blocked: 1, done: 1 });
      expect(alpha?.openCriticals).toBe(1);
      expect(alpha?.ci).toEqual({ conclusion: 'failure', unknown: false });
      expect(alpha?.drift.uncoveredRequirements).toBe(2);
      expect(alpha?.lastActivityAt).not.toBeNull();
    });

    it('says CI is unknown rather than green for a project nothing was ingested for', async () => {
      const { items } = await get<{ items: PortfolioRow[] }>('/portfolio');
      const beta = items.find((row) => row.code === 'PFB');

      // The distinction the whole column exists for: grey is not green.
      expect(beta?.ci).toEqual({ conclusion: null, unknown: true });
      expect(beta?.phase).toBeNull();
      expect(beta?.lastActivityAt).toBeNull();
      // And a count of zero is still a count, not an absence.
      expect(beta?.tasks).toEqual({ open: 0, blocked: 0, done: 0 });
    });
  });

  describe('typed search (FRM-REQ-085)', () => {
    it('labels every hit with what it is', async () => {
      const { items } = await get<{ items: SearchHit[] }>('/search?q=pg_trgm');
      const types = new Set(items.map((hit) => hit.type));

      // The same term, in a requirement and in the ADR that chose it — each labelled.
      expect(types.has('requirement')).toBe(true);
      expect(types.has('adr')).toBe(true);
      for (const hit of items) expect(hit.projectCode).toBe('PFA');
    });

    it('resolves a pasted human ID to exactly that thing, first', async () => {
      const { items } = await get<{ items: SearchHit[] }>('/search?q=PFA-REQ-001');
      expect(items[0]?.type).toBe('requirement');
      expect(items[0]?.humanId).toBe('PFA-REQ-001');
    });

    it('finds a finding by what was observed, not only by its title', async () => {
      const { items } = await get<{ items: SearchHit[] }>('/search?q=unsigned');
      const finding = items.find((hit) => hit.type === 'finding');
      expect(finding?.humanId).toBe('PFA-CR-001');
      expect(finding?.snippet).toContain('signature');
    });

    it('narrows by type', async () => {
      const { items } = await get<{ items: SearchHit[] }>('/search?q=signature&types=task');
      expect(items.length).toBeGreaterThan(0);
      for (const hit of items) expect(hit.type).toBe('task');
    });

    it('narrows by project', async () => {
      const { items } = await get<{ items: SearchHit[] }>('/search?q=webhook&project=PFB');
      expect(items).toEqual([]);
    });

    it('returns nothing for an empty query rather than everything', async () => {
      const res = await fetch(`${origin}/api/search?q=`, { headers: { cookie } });
      expect(res.status).toBe(400);
    });

    it('bounds the result set', async () => {
      const res = await fetch(`${origin}/api/search?q=the&limit=1000`, { headers: { cookie } });
      expect(res.status).toBe(400);
    });

    it('requires authentication', async () => {
      expect((await fetch(`${origin}/api/search?q=anything`)).status).toBe(401);
      expect((await fetch(`${origin}/api/portfolio`)).status).toBe(401);
    });
  });

  describe('get by human ID', () => {
    it('resolves a requirement, with what cites it', async () => {
      const requirement = await db.requirement.findFirstOrThrow({
        where: { humanId: 'PFA-REQ-001' },
      });
      const task = await db.task.findFirstOrThrow({ where: { humanId: 'PFA-T-2.2' } });
      await db.reference.upsert({
        where: {
          fromType_fromId_toType_toId_kind: {
            fromType: 'task',
            fromId: task.id,
            toType: 'requirement',
            toId: requirement.id,
            kind: 'satisfies',
          },
        },
        create: {
          fromType: 'task',
          fromId: task.id,
          toType: 'requirement',
          toId: requirement.id,
          kind: 'satisfies',
          citedAs: 'PFA-REQ-001',
        },
        update: {},
      });

      const result = await get<{
        type: string;
        projectCode: string;
        backlinks: { humanId: string; kind: string }[];
      }>('/entities/PFA-REQ-001');

      expect(result.type).toBe('requirement');
      expect(result.projectCode).toBe('PFA');
      expect(result.backlinks[0]?.humanId).toBe('PFA-T-2.2');
      expect(result.backlinks[0]?.kind).toBe('satisfies');
    });

    it('says why an unprefixed ID cannot resolve, rather than just "not found"', async () => {
      const res = await fetch(`${origin}/api/entities/REQ-001`, { headers: { cookie } });
      expect(res.status).toBe(404);
      // The ADR-008 argument, delivered where it is useful.
      expect(((await res.json()) as { error: string }).error).toContain('project-prefixed');
    });

    it('404s an ID that is well-formed but names nothing', async () => {
      const res = await fetch(`${origin}/api/entities/PFA-REQ-999`, { headers: { cookie } });
      expect(res.status).toBe(404);
    });

    it('omits backlinks when they are not asked for', async () => {
      const result = await get<{ backlinks: unknown[] }>('/entities/PFA-REQ-001?backlinks=false');
      expect(result.backlinks).toEqual([]);
    });
  });
});
