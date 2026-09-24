import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * The innovation-fund board (FRM-ADR-016, FRM-REQ-165 … FRM-REQ-172).
 *
 * Run against `FOREMAN_MODE=board`, with three real accounts rather than one, because every
 * interesting assertion here is about the boundary between two people. A suite that signs in once
 * and checks its own permissions is a suite that cannot fail the way this feature will.
 *
 * The last describe runs a second app in `solo` mode, which is the half nobody would think to
 * test: the claim is not only that the board works, but that a personal Foreman is untouched.
 */

const url = process.env['DATABASE_URL'];
const PASSWORD = 'a-password-for-the-board-tests';
const ADMIN = 'board-admin@example.com';
const REVIEWER = 'board-reviewer@example.com';
const SUBMITTER = 'board-submitter@example.com';
const INVITEE = 'board-invitee@example.com';
const SECOND_INVITEE = 'board-invitee-2@example.com';
const EMAILS = [ADMIN, REVIEWER, SUBMITTER, INVITEE, SECOND_INVITEE];

interface Idea {
  id: string;
  humanId: string;
  title: string;
  status: string;
  reason: string | null;
  fundedAmountCents: number | null;
  submittedBy: { id: string; displayName: string } | null;
  score: { count: number; impact: number | null; ratio: number | null } | null;
}

function baseConfig(mode: 'solo' | 'board'): Config {
  return loadConfig({
    NODE_ENV: 'test',
    BASE_URL: 'http://localhost:3200',
    DATABASE_URL: url ?? '',
    FOREMAN_MODE: mode,
    KEK: Buffer.alloc(32, 1).toString('base64'),
    PEPPER: Buffer.alloc(32, 2).toString('base64'),
    COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
  });
}

describe.skipIf(url === undefined)('the innovation board', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const as = (who: string, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookies[who] ?? '');
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}/api${path}`, { ...init, headers });
  };
  const post = (who: string, path: string, body?: unknown) =>
    as(who, path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const patch = (who: string, path: string, body: unknown) =>
    as(who, path, { method: 'PATCH', body: JSON.stringify(body) });

  const signIn = async (email: string, password = PASSWORD): Promise<string> => {
    const res = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  };

  beforeAll(async () => {
    const config = baseConfig('board');
    db = createDb(url ?? '');
    await db.user.deleteMany({ where: { email: { in: EMAILS } } });

    for (const [email, role] of [
      [ADMIN, 'admin'],
      [REVIEWER, 'reviewer'],
      [SUBMITTER, 'submitter'],
    ] as const) {
      const user = await db.user.create({
        data: { email, displayName: email.split('@')[0] ?? email, status: 'active', role },
      });
      ids[email] = user.id;
      await setPassword({ db, config }, user.id, PASSWORD);
    }

    server = await new Promise<Server>((resolve) => {
      const s = createApp({ config, db }).listen(0, () => {
        resolve(s);
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    origin = `http://127.0.0.1:${String(address.port)}`;

    for (const email of [ADMIN, REVIEWER, SUBMITTER]) cookies[email] = await signIn(email);
  });

  beforeEach(async () => {
    await db.projectIdea.deleteMany({ where: { title: { startsWith: 'BRD ' } } });
  });

  afterAll(async () => {
    await db.projectIdea.deleteMany({ where: { title: { startsWith: 'BRD ' } } });
    await db.user.deleteMany({ where: { email: { in: EMAILS } } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  /** A submission by the submitter, which is the starting point of nearly every test here. */
  const submit = async (title = 'BRD automated invoice matching'): Promise<Idea> => {
    const res = await post(SUBMITTER, '/project-ideas', { title, pitch: 'Saves a day a week.' });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as Idea;
  };

  describe('who may do what', () => {
    it('lets anyone signed in submit, and records who', async () => {
      const idea = await submit();
      // The audit trail always knew; the record itself did not, and a board needs a name on the
      // card rather than a name in a table nobody opens.
      expect(idea.submittedBy?.id).toBe(ids[SUBMITTER]);
    });

    it('lets a submitter reword their own submission', async () => {
      const idea = await submit();
      const res = await patch(SUBMITTER, `/project-ideas/${idea.humanId}`, {
        title: 'BRD automated invoice matching, clarified',
      });
      expect(res.status).toBe(200);
    });

    it('will not let a submitter edit somebody else’s', async () => {
      const mine = await post(REVIEWER, '/project-ideas', { title: 'BRD the reviewer’s own' });
      const theirs = (await mine.json()) as Idea;

      const res = await patch(SUBMITTER, `/project-ideas/${theirs.humanId}`, { title: 'BRD hijack' });
      expect(res.status).toBe(403);
    });

    it('will not let a submitter decide their own submission', async () => {
      const idea = await submit();
      // The failure this prevents is not malice, it is the obvious mistake: the edit form is the
      // same form, and without this the status field on it would simply work.
      const res = await patch(SUBMITTER, `/project-ideas/${idea.humanId}`, {
        status: 'rejected',
        reason: 'changed my mind',
      });
      expect(res.status).toBe(403);
    });

    it('lets a reviewer decide it', async () => {
      const idea = await submit();
      const res = await patch(REVIEWER, `/project-ideas/${idea.humanId}`, {
        status: 'shortlisted',
      });
      expect(res.status, await res.clone().text()).toBe(200);
    });

    it('lets only an admin see or change the members', async () => {
      expect((await as(ADMIN, '/board/members')).status).toBe(200);
      expect((await as(REVIEWER, '/board/members')).status).toBe(403);
      expect((await as(SUBMITTER, '/board/members')).status).toBe(403);
    });

    it('says what role was needed rather than only saying no', async () => {
      const res = await as(SUBMITTER, '/board/members');
      // A colleague reading this will otherwise ask an admin, who will otherwise ask me.
      expect(((await res.json()) as { error: string }).error).toContain('admin');
    });
  });

  describe('scoring', () => {
    it('is reviewers-only, and is not shown to the submitter', async () => {
      const idea = await submit();
      const scored = await as(REVIEWER, `/project-ideas/${idea.humanId}/scores`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ impact: 5, effort: 2, note: 'Cheap, and it removes a whole job.' }),
      });
      expect(scored.status, await scored.clone().text()).toBe(200);

      // A reviewer sees the summary on the board.
      const forReviewer = await as(REVIEWER, '/project-ideas');
      const reviewerRow = ((await forReviewer.json()) as { items: Idea[] }).items.find(
        (i) => i.humanId === idea.humanId,
      );
      expect(reviewerRow?.score?.count).toBe(1);
      expect(reviewerRow?.score?.ratio).toBe(2.5);

      // The submitter does not. Checked on the response body, not on the screen: a summary that
      // arrives and is hidden by the console has still been delivered.
      const forSubmitter = await as(SUBMITTER, '/project-ideas');
      const submitterRow = ((await forSubmitter.json()) as { items: Idea[] }).items.find(
        (i) => i.humanId === idea.humanId,
      );
      expect(submitterRow?.score).toBeNull();

      expect((await as(SUBMITTER, `/project-ideas/${idea.humanId}/scores`)).status).toBe(403);
    });

    it('treats a second score from the same reviewer as a change of mind', async () => {
      const idea = await submit();
      const put = (impact: number) =>
        as(REVIEWER, `/project-ideas/${idea.humanId}/scores`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ impact, effort: 2 }),
        });
      await put(5);
      await put(3);

      const { summary } = (await (
        await as(REVIEWER, `/project-ideas/${idea.humanId}/scores`)
      ).json()) as { summary: { count: number; impact: number } };
      expect(summary.count).toBe(1);
      expect(summary.impact).toBe(3);
    });

    it('refuses to score something already decided', async () => {
      const idea = await submit();
      await post(REVIEWER, `/board/ideas/${idea.humanId}/fund`, {
        amountCents: 1_500_000,
        reason: 'Clear payback inside a quarter.',
      });

      const res = await as(REVIEWER, `/project-ideas/${idea.humanId}/scores`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ impact: 1, effort: 5 }),
      });
      // The scores are the record of why the decision was made. Editing them afterwards rewrites
      // the reasoning behind a decision that has already been communicated.
      expect(res.status).toBe(409);
    });
  });

  describe('discussion', () => {
    it('keeps an internal note away from the submitter', async () => {
      const idea = await submit();
      await post(REVIEWER, `/project-ideas/${idea.humanId}/comments`, {
        body: 'BRD internal: is the sponsor actually committed?',
        internal: true,
      });
      await post(REVIEWER, `/project-ideas/${idea.humanId}/comments`, {
        body: 'BRD public: what is the integration cost?',
        internal: false,
      });

      const seenByReviewer = (await (
        await as(REVIEWER, `/project-ideas/${idea.humanId}/comments`)
      ).json()) as { items: { body: string }[] };
      expect(seenByReviewer.items).toHaveLength(2);

      const seenBySubmitter = (await (
        await as(SUBMITTER, `/project-ideas/${idea.humanId}/comments`)
      ).json()) as { items: { body: string }[] };
      expect(seenBySubmitter.items).toHaveLength(1);
      expect(seenBySubmitter.items[0]?.body).toContain('public');
    });

    it('will not let a submitter write one they could not read back', async () => {
      const idea = await submit();
      const res = await post(SUBMITTER, `/project-ideas/${idea.humanId}/comments`, {
        body: 'BRD sneaky',
        internal: true,
      });
      expect(res.status).toBe(422);
    });

    it('lets a person withdraw their own comment and nobody else’s', async () => {
      const idea = await submit();
      const made = (await (
        await post(SUBMITTER, `/project-ideas/${idea.humanId}/comments`, { body: 'BRD mine' })
      ).json()) as { id: string };

      expect((await as(REVIEWER, `/project-ideas/${idea.humanId}/comments/${made.id}`, { method: 'DELETE' })).status).toBe(
        422,
      );
      expect((await as(SUBMITTER, `/project-ideas/${idea.humanId}/comments/${made.id}`, { method: 'DELETE' })).status).toBe(
        200,
      );
    });
  });

  describe('funding', () => {
    it('records the amount and the reason, and tells the submitter', async () => {
      const idea = await submit();
      const res = await post(REVIEWER, `/board/ideas/${idea.humanId}/fund`, {
        amountCents: 1_500_000,
        reason: 'Clear payback inside a quarter, and the sponsor is committed.',
      });
      expect(res.status, await res.clone().text()).toBe(200);

      const funded = (await res.json()) as Idea;
      expect(funded.status).toBe('funded');
      expect(funded.fundedAmountCents).toBe(1_500_000);
      // Public, unlike the scores. This is the half most boards never write down, and the half
      // that stops the same proposal arriving again next quarter.
      expect(funded.reason).toContain('payback');
    });

    it('refuses an amount a submitter could set themselves', async () => {
      const idea = await submit();
      const res = await post(SUBMITTER, `/board/ideas/${idea.humanId}/fund`, {
        amountCents: 100,
        reason: 'go on',
      });
      expect(res.status).toBe(403);
    });

    it('refuses a funding decision with no reason', async () => {
      const idea = await submit();
      const res = await post(REVIEWER, `/board/ideas/${idea.humanId}/fund`, {
        amountCents: 100_000,
      });
      expect(res.status).toBe(400);
    });

    it('will not fund the same thing twice', async () => {
      const idea = await submit();
      const body = { amountCents: 100_000, reason: 'Worth doing.' };
      expect((await post(REVIEWER, `/board/ideas/${idea.humanId}/fund`, body)).status).toBe(200);
      expect((await post(REVIEWER, `/board/ideas/${idea.humanId}/fund`, body)).status).toBe(409);
    });
  });

  describe('members', () => {
    it('invites somebody, and the invitation is usable exactly once', async () => {
      const invited = await post(ADMIN, '/board/members/invite', {
        email: INVITEE,
        displayName: 'Invitee',
        role: 'submitter',
      });
      expect(invited.status, await invited.clone().text()).toBe(201);
      const { acceptUrl } = (await invited.json()) as { acceptUrl: string };
      const token = new URL(acceptUrl).searchParams.get('token') ?? '';
      expect(token.length).toBeGreaterThan(20);

      const accept = (password: string) =>
        fetch(`${origin}/auth/invite/accept`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, password }),
        });

      expect((await accept('a-long-enough-password')).status).toBe(200);
      // Single use. A forwarded email must not be a second way in.
      expect((await accept('another-long-password')).status).toBe(404);

      // Accepting returned no session — it set a password, which they now have to use. Signing in
      // with the one they chose is the proof; the second `accept` above did not change it.
      expect((await signIn(INVITEE, 'a-long-enough-password')).length).toBeGreaterThan(0);
      expect((await signIn(INVITEE, 'another-long-password')).length).toBe(0);
    });

    it('stores the invitation as a hash, never as the token', async () => {
      // Its own invitee: the test above activates the first one, and re-inviting somebody who
      // already accepted is refused on purpose.
      const invited = await post(ADMIN, '/board/members/invite', {
        email: SECOND_INVITEE,
        displayName: 'Second invitee',
        role: 'reviewer',
      });
      expect(invited.status, await invited.clone().text()).toBe(201);
      const { acceptUrl } = (await invited.json()) as { acceptUrl: string };
      const token = new URL(acceptUrl).searchParams.get('token') ?? '';

      const rows = await db.invite.findMany({ select: { tokenHash: true } });
      // A leaked database row must not be a way in — the same rule as a session and an API token.
      expect(rows.every((r) => r.tokenHash !== token)).toBe(true);
    });

    it('refuses to demote the only admin', async () => {
      // An instance with no admin cannot appoint one, and the fix is a database console.
      const res = await patch(ADMIN, `/board/members/${ids[ADMIN] ?? ''}`, { role: 'submitter' });
      expect(res.status).toBe(422);
    });
  });
});

describe.skipIf(url === undefined)('a solo Foreman is untouched by any of it', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;
  const EMAIL = 'solo-operator@example.com';

  beforeAll(async () => {
    const config = baseConfig('solo');
    db = createDb(url ?? '');
    await db.user.deleteMany({ where: { email: EMAIL } });
    const user = await db.user.create({
      data: { email: EMAIL, displayName: 'Operator', status: 'active', role: 'submitter' },
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

    const res = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  afterAll(async () => {
    await db.projectIdea.deleteMany({ where: { title: { startsWith: 'SOLO ' } } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  it('offers no board surface at all', async () => {
    // Members and money: the two things that only mean something with more than one person.
    const members = await fetch(`${origin}/api/board/members`, { headers: { cookie } });
    const fund = await fetch(`${origin}/api/board/ideas/PI-001/fund`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ amountCents: 100, reason: 'anything' }),
    });
    // 404, not 403: there is no board here, which is a different statement from "not for you".
    expect(members.status).toBe(404);
    expect(fund.status).toBe(404);
  });

  it('keeps a thoughts log and a self-rating, which are not board features', async () => {
    // FRM-ADR-017: scoring and discussion moved out of the board because they turned out to be
    // just as useful to one person. On a solo instance they are your impact/effort read on an idea
    // and your running notes on it — and the operator's `submitter` row must not get in the way.
    const made = await fetch(`${origin}/api/project-ideas`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'SOLO worth rating' }),
    });
    const idea = (await made.json()) as { humanId: string };

    const thought = await fetch(`${origin}/api/project-ideas/${idea.humanId}/comments`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Could reuse the Bindery ingest pipeline for this.' }),
    });
    expect(thought.status, await thought.clone().text()).toBe(201);

    const rated = await fetch(`${origin}/api/project-ideas/${idea.humanId}/scores`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ impact: 4, effort: 2 }),
    });
    expect(rated.status, await rated.clone().text()).toBe(200);

    const list = await fetch(`${origin}/api/project-ideas`, { headers: { cookie } });
    const row = ((await list.json()) as { items: { humanId: string; score: { ratio: number } | null }[] })
      .items.find((i) => i.humanId === idea.humanId);
    expect(row?.score?.ratio).toBe(2);
  });

  it('ignores roles entirely, so the one operator can still do everything', async () => {
    // The account above is deliberately a `submitter`. In `solo` that must mean nothing — a
    // personal instance has one person, and locking them out of their own ideas over a column
    // they never set would be the upgrade breaking the thing it was not supposed to touch.
    const made = await fetch(`${origin}/api/project-ideas`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'SOLO still mine' }),
    });
    expect(made.status).toBe(201);
    const idea = (await made.json()) as { humanId: string };

    const decided = await fetch(`${origin}/api/project-ideas/${idea.humanId}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'parked', reason: 'Not this quarter.' }),
    });
    expect(decided.status, await decided.clone().text()).toBe(200);
  });
});
