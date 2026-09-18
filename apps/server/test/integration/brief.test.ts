import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { approximateTokens, BRIEF_TOKEN_BUDGET, type Brief } from '../../src/domain/brief.js';

/**
 * The session brief (T-1.7).
 *
 * Two assertions here are the ones that matter most in the whole project, and they are the two the
 * plan names: a blocked task never appears among the next tasks, and an unconfirmed attribution is
 * never counted as truth. The rest is shape.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'brief@example.com';
const PASSWORD = 'a-password-for-the-brief-tests';
const CODE = 'BRF';

describe.skipIf(url === undefined)('the session brief', () => {
  let db: Db;
  let config: Config;
  let server: Server;
  let origin: string;
  let cookie: string;
  let projectId: string;
  let phaseId: string;

  const getBrief = async (): Promise<{ brief: Brief; tokensHeader: string | null }> => {
    const res = await fetch(`${origin}/api/brief/${CODE}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    return { brief: (await res.json()) as Brief, tokensHeader: res.headers.get('x-foreman-approx-tokens') };
  };

  beforeAll(async () => {
    config = loadConfig({
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
      data: { email: EMAIL, displayName: 'Brief', status: 'active' },
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
    await db.project.deleteMany({ where: { code: CODE } });
    const project = await db.project.create({
      data: {
        code: CODE,
        name: 'Brief Test',
        slug: 'brief-test',
        lifecycle: 'building',
        pitch: 'A project that exists to be summarised.',
      },
    });
    projectId = project.id;

    const phase = await db.phase.create({
      data: {
        projectId,
        humanId: `${CODE}-P-1`,
        number: 1,
        sortOrder: 1,
        name: 'Where Are We',
        status: 'active',
        objective: 'Answer the question this brief exists to answer.',
        exitDemo: 'Ask, and get an accurate answer.',
      },
    });
    phaseId = phase.id;
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  const addTask = (humanId: string, data: Record<string, unknown> = {}) =>
    db.task.create({
      data: {
        projectId,
        phaseId,
        humanId,
        title: `Task ${humanId}`,
        ...data,
      },
    });

  it('names the project, its active phase, and how far along it is', async () => {
    await addTask(`${CODE}-T-1.1`, { status: 'done' });
    await addTask(`${CODE}-T-1.2`, { status: 'todo' });

    const { brief } = await getBrief();
    expect(brief.project.code).toBe(CODE);
    expect(brief.activePhase?.humanId).toBe(`${CODE}-P-1`);
    expect(brief.activePhase?.tasks).toEqual({ done: 1, total: 2 });
  });

  it('never offers a blocked task as something to work on', async () => {
    await addTask(`${CODE}-T-1.1`, {
      status: 'blocked',
      blockedReason: 'Waiting on the GitHub App installation.',
    });
    await addTask(`${CODE}-T-1.2`, { status: 'todo' });

    const { brief } = await getBrief();
    // The requirement, stated twice: not in next, and present where it belongs.
    expect(brief.nextTasks.map((t) => t.humanId)).toEqual([`${CODE}-T-1.2`]);
    expect(brief.blocked.map((t) => t.humanId)).toEqual([`${CODE}-T-1.1`]);
    expect(brief.blocked[0]?.reason).toContain('GitHub App');
  });

  it('offers nothing to work on when everything is blocked, rather than offering the blocked work', async () => {
    await addTask(`${CODE}-T-1.1`, { status: 'blocked', blockedReason: 'Upstream.' });

    const { brief } = await getBrief();
    expect(brief.nextTasks).toEqual([]);
    expect(brief.blocked).toHaveLength(1);
  });

  it('does not count an unconfirmed attribution as truth (ADR-005)', async () => {
    const task = await addTask(`${CODE}-T-1.1`, { status: 'todo' });
    const repo = await db.repo.create({ data: { projectId, fullName: 'test/brief' } });
    const commit = await db.commit.create({
      data: {
        repoId: repo.id,
        sha: 'f'.repeat(40),
        message: 'Touches a path this task declared',
        author: 'tester',
        committedAt: new Date(),
      },
    });
    await db.commitTask.create({
      data: {
        commitId: commit.id,
        taskId: task.id,
        source: 'file_overlap',
        confidence: 0.4,
        confirmed: false,
      },
    });

    const { brief } = await getBrief();
    // The task is still work to do: a file-path coincidence has not completed it.
    expect(brief.nextTasks.map((t) => t.humanId)).toEqual([`${CODE}-T-1.1`]);
    // And the proposal is surfaced as something awaiting a decision.
    expect(brief.drift.unconfirmedAttributions).toBe(1);
  });

  it('reports CI as unknown rather than as failing when nothing has been ingested', async () => {
    const { brief } = await getBrief();
    expect(brief.ci.unknown).toBe(true);
    expect(brief.ci.conclusion).toBeNull();
  });

  it('reports the most recent finished check run', async () => {
    const repo = await db.repo.create({ data: { projectId, fullName: 'test/brief-ci' } });
    await db.checkRun.createMany({
      data: [
        {
          repoId: repo.id,
          commitSha: 'a'.repeat(40),
          name: 'ci',
          conclusion: 'failure',
          completedAt: new Date(Date.now() - 86_400_000),
        },
        {
          repoId: repo.id,
          commitSha: 'b'.repeat(40),
          name: 'ci',
          conclusion: 'success',
          completedAt: new Date(),
        },
      ],
    });

    const { brief } = await getBrief();
    expect(brief.ci.unknown).toBe(false);
    expect(brief.ci.conclusion).toBe('success');
  });

  it('surfaces open criticals, worst first, and ignores the ones already fixed', async () => {
    await db.finding.createMany({
      data: [
        {
          projectId,
          humanId: `${CODE}-CR-001`,
          title: 'A critical that is open',
          severity: 'critical',
          status: 'open',
          locationRaw: 'apps/server/src/x.ts:10-20',
        },
        {
          projectId,
          humanId: `${CODE}-CR-002`,
          title: 'A high that is open',
          severity: 'high',
          status: 'open',
        },
        {
          projectId,
          humanId: `${CODE}-CR-003`,
          title: 'A critical that is fixed',
          severity: 'critical',
          status: 'fixed',
        },
        {
          projectId,
          humanId: `${CODE}-CR-004`,
          title: 'A low that nobody needs in a brief',
          severity: 'low',
          status: 'open',
        },
      ],
    });

    const { brief } = await getBrief();
    expect(brief.openCriticals.map((f) => f.humanId)).toEqual([
      `${CODE}-CR-001`,
      `${CODE}-CR-002`,
    ]);
    expect(brief.openCriticals[0]?.location).toBe('apps/server/src/x.ts:10-20');
  });

  it('counts the drift that matters: coverage holes and fired tripwires', async () => {
    await db.requirement.createMany({
      data: [
        { projectId, humanId: `${CODE}-REQ-001`, seq: 1, statement: 'Covered.' },
        { projectId, humanId: `${CODE}-REQ-002`, seq: 2, statement: 'Not covered.' },
      ],
    });
    const covered = await db.requirement.findFirstOrThrow({
      where: { humanId: `${CODE}-REQ-001` },
    });
    const task = await addTask(`${CODE}-T-1.1`);
    await db.taskRequirement.create({ data: { taskId: task.id, requirementId: covered.id } });

    await db.risk.create({
      data: {
        projectId,
        humanId: `${CODE}-R-01`,
        title: 'A tripwire that has fired',
        status: 'fired',
        firedAt: new Date(),
      },
    });

    const { brief } = await getBrief();
    expect(brief.drift.uncoveredRequirements).toBe(1);
    expect(brief.drift.firedRisks).toBe(1);
  });

  it('stays inside its token budget with a realistic amount of everything', async () => {
    // Deliberately more than a brief should ever show: it must summarise, not enumerate.
    for (let i = 1; i <= 25; i++) {
      await addTask(`${CODE}-T-1.${String(i)}`, {
        status: i % 4 === 0 ? 'blocked' : 'todo',
        ...(i % 4 === 0 ? { blockedReason: 'Something upstream is not ready yet.' } : {}),
        doneWhen: 'The thing it describes is demonstrably working end to end.',
      });
    }
    await db.finding.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        projectId,
        humanId: `${CODE}-CR-${String(i + 1).padStart(3, '0')}`,
        title: `An open finding with a reasonably descriptive title, number ${String(i + 1)}`,
        severity: 'critical' as const,
        status: 'open' as const,
      })),
    });

    const { brief, tokensHeader } = await getBrief();
    const tokens = approximateTokens(brief);

    expect(brief.nextTasks.length).toBeLessThanOrEqual(5);
    expect(brief.openCriticals.length).toBeLessThanOrEqual(5);
    expect(tokens).toBeLessThan(BRIEF_TOKEN_BUDGET);
    // The header lets a caller see the cost without measuring it.
    expect(Number(tokensHeader)).toBe(tokens);
  });

  it('404s an unknown project rather than returning an empty brief', async () => {
    const res = await fetch(`${origin}/api/brief/NOPE`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    const res = await fetch(`${origin}/api/brief/${CODE}`);
    expect(res.status).toBe(401);
  });
});
