import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
// Source, not the package name: `exports` points at `dist` because this package is published,
// and a test is not a reason to make the published shape wrong.
import { createClient } from '../../../../packages/mcp/src/client.js';
import { createServer as createMcpServer } from '../../../../packages/mcp/src/server.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * The shim against a **real Foreman**, over the real protocol, with a real scoped token.
 *
 * Everything else about the MCP surface is tested against a stub: the tool definitions in
 * `contract.test.ts`, the protocol in `protocol.test.ts`. This is the one that proves the path
 * Claude actually takes end to end — token in an Authorization header, HTTP to an Express app, a
 * database behind it — and it is where a mismatch between what a tool builds and what a route
 * accepts finally shows up.
 */

const url = process.env['DATABASE_URL'];
const EMAIL = 'mcp@example.com';
const PASSWORD = 'a-password-for-the-mcp-tests';
const CODE = 'MCP';

describe.skipIf(url === undefined)('the MCP shim, end to end', () => {
  let db: Db;
  let server: Server;
  let origin: string;
  let cookie: string;
  let readToken: string;
  let writeToken: string;
  /** The seeded task's ID. It carries its phase, so it is not predictable from the code alone. */
  let taskId: string;

  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}/api${path}`, { ...init, headers });
  };
  const post = (path: string, body?: unknown) =>
    api(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  /** A connected MCP client speaking to a server whose HTTP client holds a real token. */
  async function connect(token: string) {
    const mcp = createMcpServer({ client: createClient({ baseUrl: origin, token }) });
    const client = new Client(
      { name: 'e2e', version: '0.0.0' },
      { capabilities: { elicitation: {} } },
    );
    const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    client.setRequestHandler(ElicitRequestSchema, () => ({
      action: 'accept' as const,
      content: { confirm: true },
    }));

    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), mcp.connect(b)]);
    return client;
  }

  /** The text of a tool result. The SDK's union includes a `toolResult` shape with no content. */
  const text = (result: unknown): string => {
    const content = (result as { content?: { text?: string }[] }).content;
    return (content ?? []).map((part) => part.text ?? '').join('\n');
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
      data: { email: EMAIL, displayName: 'MCP', status: 'active' },
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

    // Real tokens, issued through the real route.
    readToken = ((await (await post('/tokens', { name: 'mcp read', scopes: ['read'] })).json()) as {
      token: string;
    }).token;
    writeToken = ((await (
      await post('/tokens', { name: 'mcp write', scopes: ['read', 'write'] })
    ).json()) as { token: string }).token;

    // A project with something in it to read.
    await db.project.deleteMany({ where: { code: CODE } });
    await post('/projects', { code: CODE, name: 'MCP Test' });
    await post(`/projects/${CODE}/phases`, { number: 1, name: 'The phase' });
    const phase = await db.phase.findFirstOrThrow({ where: { humanId: `${CODE}-P-1` } });

    const requirement = await post(`/projects/${CODE}/requirements`, {
      statement: 'Foreman shall be readable through the shim.',
      priority: 'M',
      phaseId: phase.id,
    });
    const { id } = (await requirement.json()) as { id: string };

    // In the phase: the brief's "next up" is scoped to the active phase, so a task outside every
    // phase is correctly absent from it — realistic setup rather than a weakened assertion.
    const task = await post(`/projects/${CODE}/tasks`, {
      title: 'Read it through the shim',
      phaseId: phase.id,
      requirementIds: [id],
    });
    taskId = ((await task.json()) as { humanId: string }).humanId;
    await post(`/projects/${CODE}/documents`, {
      kind: 'architecture',
      title: 'Architecture',
      sections: [
        { heading: 'Deployment', bodyMd: 'Behind a Cloudflare Tunnel, with no host ports.' },
        { heading: 'Data model', bodyMd: 'Thirty-six tables.' },
      ],
    });
  });

  afterAll(async () => {
    await db.project.deleteMany({ where: { code: CODE } });
    await db.apiToken.deleteMany({ where: { name: { startsWith: 'mcp ' } } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  describe('reading', () => {
    it('gets a brief through the whole path', async () => {
      const client = await connect(readToken);
      const result = await client.callTool({ name: 'foreman_brief', arguments: { project: CODE } });

      expect(result.isError).toBeFalsy();
      const brief = JSON.parse(text(result)) as {
        project: { code: string };
        nextTasks: { humanId: string }[];
      };
      expect(brief.project.code).toBe(CODE);
      expect(brief.nextTasks[0]?.humanId).toBe(taskId);
    });

    it('lists the portfolio', async () => {
      const client = await connect(readToken);
      const result = await client.callTool({ name: 'foreman_portfolio', arguments: {} });

      const page = JSON.parse(text(result)) as { items: { code: string }[] };
      expect(page.items.some((p) => p.code === CODE)).toBe(true);
    });

    it('resolves an entity by human ID, with what cites it', async () => {
      const client = await connect(readToken);
      const result = await client.callTool({
        name: 'foreman_get',
        arguments: { id: `${CODE}-REQ-001` },
      });

      const entity = JSON.parse(text(result)) as { type: string; backlinks: unknown[] };
      expect(entity.type).toBe('requirement');
      expect(Array.isArray(entity.backlinks)).toBe(true);
    });

    it('searches across projects', async () => {
      const client = await connect(readToken);
      const result = await client.callTool({
        name: 'foreman_search',
        arguments: { q: 'readable through the shim' },
      });

      const page = JSON.parse(text(result)) as { items: { humanId: string | null }[] };
      expect(page.items.some((hit) => hit.humanId === `${CODE}-REQ-001`)).toBe(true);
    });

    it('reports coverage, and the gate for a phase', async () => {
      const client = await connect(readToken);

      const coverage = JSON.parse(
        text(await client.callTool({ name: 'foreman_coverage', arguments: { project: CODE } })),
      ) as { requirements: { musts: number } };
      expect(coverage.requirements.musts).toBe(1);

      const gate = JSON.parse(
        text(
          await client.callTool({
            name: 'foreman_coverage',
            arguments: { project: CODE, phase: `${CODE}-P-1` },
          }),
        ),
      ) as { passed: boolean };
      // Asking is not completing: the phase is untouched either way.
      expect(typeof gate.passed).toBe('boolean');
      const phase = await db.phase.findFirstOrThrow({ where: { humanId: `${CODE}-P-1` } });
      expect(phase.status).toBe('planned');
    });

    it('lists findings across every project', async () => {
      const client = await connect(readToken);
      const result = await client.callTool({ name: 'foreman_findings', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(text(result))).toHaveProperty('items');
    });
  });

  describe('documents as resources', () => {
    it('lists them, then reads one section rather than the document', async () => {
      const client = await connect(readToken);

      const { resources } = await client.listResources();
      const section = resources.find((r) => r.uri.endsWith('#deployment'));
      expect(section, 'the seeded section should be listed').toBeDefined();

      const read = await client.readResource({ uri: section?.uri ?? '' });
      // A resource's content is text *or* a blob; these are markdown.
      const body = (read.contents[0] as { text?: string } | undefined)?.text ?? '';
      expect(body).toContain('no host ports');
      // The whole argument for addressing sections: the rest of the document is not in the answer.
      expect(body).not.toContain('Thirty-six tables');
    });
  });

  describe('writing', () => {
    it('creates a task, and it is really there', async () => {
      const client = await connect(writeToken);
      const result = await client.callTool({
        name: 'foreman_create',
        arguments: { project: CODE, kind: 'task', text: 'Created through the shim' },
      });

      expect(result.isError).toBeFalsy();
      const created = await db.task.findFirst({ where: { title: 'Created through the shim' } });
      expect(created).not.toBeNull();
    });

    it('advances a task, and the audit trail names the token that did it', async () => {
      const client = await connect(writeToken);
      await client.callTool({
        name: 'foreman_set_status',
        arguments: { id: taskId, status: 'in_progress' },
      });

      const task = await db.task.findFirstOrThrow({ where: { humanId: taskId } });
      expect(task.status).toBe('in_progress');

      const event = await db.auditEvent.findFirstOrThrow({
        where: { entityHumanId: taskId, action: 'update' },
        orderBy: { createdAt: 'desc' },
      });
      // Every mutation writes an audit event, MCP writes included — and the actor is the token,
      // not a person, so "who changed this" has an answer.
      expect(event.actorKind).toBe('mcp');
      expect(event.actor).toContain('mcp write');
    });

    it('declares an attribution, which arrives confirmed', async () => {
      const project = await db.project.findFirstOrThrow({ where: { code: CODE } });
      const repo = await db.repo.create({
        data: { projectId: project.id, fullName: 'matdemers1/mcp-test' },
      });
      await db.commit.create({
        data: {
          repoId: repo.id,
          sha: 'a'.repeat(40),
          message: 'Work',
          author: 'matt',
          committedAt: new Date(),
        },
      });

      const client = await connect(writeToken);
      await client.callTool({
        name: 'foreman_attribute',
        arguments: { sha: 'a'.repeat(12), task: taskId },
      });

      const row = await db.commitTask.findFirstOrThrow();
      // Signal 1: the one party that was there saying what it did, so it is a fact on arrival.
      expect(row.confirmed).toBe(true);
      expect(row.source).toBe('declared');
    });
  });

  describe('a reason belongs to the status it explains', () => {
    it('records a blocked reason when blocking', async () => {
      const client = await connect(writeToken);
      await client.callTool({
        name: 'foreman_set_status',
        arguments: { id: taskId, status: 'blocked', reason: 'Waiting on the scanner.' },
      });
      const task = await db.task.findUniqueOrThrow({ where: { humanId: taskId } });

      expect(task.status).toBe('blocked');
      expect(task.blockedReason).toBe('Waiting on the scanner.');
    });

    it('does not store a completion note as a blocked reason', async () => {
      const client = await connect(writeToken);
      // Independent of the test above: it leaves a real blocked reason behind, and a stale one
      // surviving a move out of `blocked` is a separate question from the one being asked here.
      await db.task.update({ where: { humanId: taskId }, data: { blockedReason: null } });
      // Found while marking the cutover's own tasks done through this tool: the reason was sent
      // whatever the status was, so a note explaining why something was *finished* landed in
      // `blockedReason` — which reads, to anyone who finds it later, as a record of it being stuck.
      await client.callTool({
        name: 'foreman_set_status',
        arguments: { id: taskId, status: 'done', reason: 'Snapshot taken and verified.' },
      });
      const task = await db.task.findUniqueOrThrow({ where: { humanId: taskId } });

      expect(task.status).toBe('done');
      expect(task.blockedReason).toBeNull();
    });
  });

  describe('the token is the boundary', () => {
    it('refuses a write with a read-only token, and says so readably', async () => {
      const client = await connect(readToken);
      const result = await client.callTool({
        name: 'foreman_create',
        arguments: { project: CODE, kind: 'task', text: 'Should never exist' },
      });

      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/403|scope|forbidden/i);
      expect(await db.task.count({ where: { title: 'Should never exist' } })).toBe(0);
    });

    it('refuses everything with a token that is not real', async () => {
      const client = await connect('frm_not-a-real-token');
      const result = await client.callTool({ name: 'foreman_portfolio', arguments: {} });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('401');
    });

    it('refuses a revoked token', async () => {
      const revoked = ((await (
        await post('/tokens', { name: 'mcp revoked', scopes: ['read'] })
      ).json()) as { token: string; id: string });
      await api(`/tokens/${revoked.id}`, { method: 'DELETE' });

      const client = await connect(revoked.token);
      const result = await client.callTool({ name: 'foreman_portfolio', arguments: {} });
      expect(result.isError).toBe(true);
    });

    it('records the read token’s own name against what it read', async () => {
      const client = await connect(readToken);
      await client.callTool({ name: 'foreman_brief', arguments: { project: CODE } });

      const token = await db.apiToken.findFirstOrThrow({ where: { name: 'mcp read' } });
      // Last-used, so a token nobody has used in six months is visible as such.
      expect(token.lastUsedAt).not.toBeNull();
    });
  });

  describe('when Foreman is not there', () => {
    it('returns a readable error rather than hanging', async () => {
      const client = await connect(readToken);
      // A port nothing is listening on: the shim must fail as a tool result, not a dropped
      // connection, or a model sees its session end rather than a problem it could report.
      const mcp = createMcpServer({
        client: createClient({ baseUrl: 'http://127.0.0.1:1', token: readToken, timeoutMs: 2000 }),
      });
      const offline = new Client({ name: 'offline', version: '0.0.0' }, { capabilities: {} });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([offline.connect(a), mcp.connect(b)]);

      const result = await offline.callTool({ name: 'foreman_portfolio', arguments: {} });
      expect(result.isError).toBe(true);
      expect(text(result).length).toBeGreaterThan(0);
      expect(client).toBeDefined();
    });
  });
});
