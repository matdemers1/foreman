import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { ForemanClient } from '../src/client.js';
import { createServer } from '../src/server.js';
import { MAX_TOOLS } from '../src/tools/index.js';
import { WRITE_TOOLS } from '../src/tools/writes.js';

/**
 * The shim over the **actual protocol** (T-1.9, T-2.8, T-4.9).
 *
 * Everything in `contract.test.ts` tests the tool definitions: their schemas, their gates, the URL
 * each one builds. That is most of the risk, but not all of it — none of it goes through the SDK.
 * A tool registered with a schema the SDK rejects, a resource template that matches nothing, a
 * result shape a client cannot parse: all of those pass a definition test and fail the first time
 * Claude connects.
 *
 * So these drive a real `Client` over a linked in-memory transport: `initialize`, `tools/list`,
 * `tools/call`, `resources/list`, `resources/read` — the same calls Claude makes, through the same
 * code path, with only the network replaced.
 */

/** A Foreman API that answers from a table, so a test can say what the server saw. */
function fakeApi(responses: Record<string, unknown> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];

  const match = (path: string): unknown => {
    for (const [pattern, value] of Object.entries(responses)) {
      if (path === pattern || path.startsWith(pattern)) return value;
    }
    return {};
  };

  const client: ForemanClient = {
    get: (path) => {
      calls.push({ method: 'GET', path });
      return Promise.resolve(match(path) as never);
    },
    post: (path, body) => {
      calls.push({ method: 'POST', path, body });
      return Promise.resolve(match(path) as never);
    },
    patch: (path, body) => {
      calls.push({ method: 'PATCH', path, body });
      return Promise.resolve(match(path) as never);
    },
    del: (path) => {
      calls.push({ method: 'DELETE', path });
      return Promise.resolve(match(path) as never);
    },
  };

  return { client, calls };
}

/** A connected client/server pair, with the transports linked in memory. */
async function connect(
  api: ForemanClient,
  clientOptions: { elicitation?: (message: string) => { confirm: boolean } | 'decline' } = {},
) {
  const server = createServer({ client: api });
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    // Elicitation is declared only when the test provides a handler, so the "client cannot be
    // asked" path is reachable too.
    { capabilities: clientOptions.elicitation === undefined ? {} : { elicitation: {} } },
  );

  if (clientOptions.elicitation !== undefined) {
    const handler = clientOptions.elicitation;
    client.setRequestHandler(
      (await import('@modelcontextprotocol/sdk/types.js')).ElicitRequestSchema,
      (request) => {
        const answer = handler(request.params.message);
        return answer === 'decline'
          ? { action: 'decline' as const }
          : { action: 'accept' as const, content: { confirm: answer.confirm } };
      },
    );
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

/** The text of a tool result. The SDK's union includes a `toolResult` shape with no content. */
const text = (result: unknown): string => {
  const content = (result as { content?: { text?: string }[] }).content;
  return (content ?? []).map((part) => part.text ?? '').join('\n');
};

describe('initialize and the handshake', () => {
  it('connects, and declares the capabilities it actually implements', async () => {
    const { client } = await connect(fakeApi().client);

    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tools).toBeDefined();
    expect(capabilities?.resources).toBeDefined();
    // Nothing is claimed that is not implemented: a declared capability with no handler is a
    // client calling something that answers "method not found".
    expect(capabilities?.prompts).toBeUndefined();
    expect(capabilities?.logging).toBeUndefined();
  });

  it('carries instructions that tell a client where to start', async () => {
    const { client } = await connect(fakeApi().client);
    // The first thing a model reads. "Call foreman_brief first" is worth more than a tool list.
    expect(client.getInstructions() ?? '').toContain('foreman_brief');
  });
});

describe('tools/list over the protocol', () => {
  it('lists every tool, inside the ceiling', async () => {
    const { client } = await connect(fakeApi().client);
    const { tools } = await client.listTools();

    expect(tools.length).toBeGreaterThan(5);
    expect(tools.length).toBeLessThanOrEqual(MAX_TOOLS);
    expect(tools.every((t) => t.name.startsWith('foreman_'))).toBe(true);
  });

  it('gives every tool a usable JSON Schema, not an empty object', async () => {
    const { client } = await connect(fakeApi().client);
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      // `foreman_portfolio` legitimately takes nothing; everything else must describe its input,
      // or the model is guessing at argument names.
      if (tool.name !== 'foreman_portfolio') {
        expect(Object.keys(tool.inputSchema.properties ?? {}).length, tool.name).toBeGreaterThan(0);
      }
    }
  });

  it('marks the read tools read-only and the write tools not', async () => {
    const { client } = await connect(fakeApi().client);
    const { tools } = await client.listTools();

    const brief = tools.find((t) => t.name === 'foreman_brief');
    const create = tools.find((t) => t.name === 'foreman_create');
    // A client that skips a confirmation for a read is relying on this being right.
    expect(brief?.annotations?.readOnlyHint).toBe(true);
    expect(create?.annotations?.readOnlyHint).toBe(false);
  });

  it('describes every tool in a sentence a model can choose from', async () => {
    const { client } = await connect(fakeApi().client);
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.description ?? '', tool.name).not.toBe('');
      expect((tool.description ?? '').length, tool.name).toBeLessThan(220);
    }
  });
});

describe('tools/call over the protocol', () => {
  it('calls the brief and returns the API’s answer as text', async () => {
    const { client: api, calls } = fakeApi({
      '/api/brief/BND': { project: { code: 'BND', name: 'Bindery' }, nextTasks: [] },
    });
    const { client } = await connect(api);

    const result = await client.callTool({ name: 'foreman_brief', arguments: { project: 'BND' } });

    expect(calls[0]?.path).toBe('/api/brief/BND');
    expect(text(result)).toContain('Bindery');
    expect(result.isError).toBeFalsy();
  });

  it('carries the cache metadata a client needs to not re-ask', async () => {
    const { client } = await connect(fakeApi().client);
    const result = await client.callTool({ name: 'foreman_brief', arguments: { project: 'BND' } });

    const meta = result._meta as Record<string, { ttlMs: number; cacheScope: string }> | undefined;
    expect(meta?.['io.d3cloud.foreman/cache']?.ttlMs).toBeGreaterThan(0);
    expect(meta?.['io.d3cloud.foreman/cache']?.cacheScope).toBe('project');
  });

  it('refuses input the shared schema rejects, as a readable error', async () => {
    const { client } = await connect(fakeApi().client);
    // `REQ-021` is not project-prefixed, so it is ambiguous by construction (ADR-008).
    const result = await client.callTool({ name: 'foreman_get', arguments: { id: 'REQ-021' } });

    expect(result.isError).toBe(true);
    // A model has to be able to read this and fix its own call.
    expect(text(result).toLowerCase()).toMatch(/expected|invalid|human id/);
  });

  it('returns an API failure as a tool error rather than killing the call', async () => {
    const failing: ForemanClient = {
      get: () => Promise.reject(Object.assign(new Error('no such project'), { status: 404 })),
      post: () => Promise.reject(new Error('unused')),
      patch: () => Promise.reject(new Error('unused')),
      del: () => Promise.reject(new Error('unused')),
    };
    const { client } = await connect(failing);

    const result = await client.callTool({ name: 'foreman_brief', arguments: { project: 'ZZZ' } });
    // A protocol error ends the call; a tool error is something the model can read and act on.
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no such project');
  });

  it('answers a tool that does not exist as an error result, not a dropped connection', async () => {
    const { client } = await connect(fakeApi().client);
    const result = await client.callTool({ name: 'foreman_nonsense', arguments: {} });

    // The SDK answers rather than rejecting, which is the better behaviour: a model that guessed
    // a tool name can read the reply and pick a real one.
    expect(result.isError).toBe(true);
    expect(text(result).toLowerCase()).toContain('foreman_nonsense');
  });

  it('passes search filters through as the API expects them', async () => {
    const { client: api, calls } = fakeApi({ '/api/search': { items: [] } });
    const { client } = await connect(api);

    await client.callTool({
      name: 'foreman_search',
      arguments: { q: 'pg_trgm', types: ['adr', 'requirement'], project: 'BND', limit: 5 },
    });

    expect(calls[0]?.path).toBe('/api/search');
  });
});

describe('the confirmation round-trip (T-2.9, ADR-011)', () => {
  it('asks before cancelling, and does not call the API when declined', async () => {
    const { client: api, calls } = fakeApi({
      '/api/entities/BND-T-1.1': { type: 'task', entity: { status: 'in_progress' } },
    });
    let asked = '';
    const { client } = await connect(api, {
      elicitation: (message) => {
        asked = message;
        return 'decline';
      },
    });

    const result = await client.callTool({
      name: 'foreman_set_status',
      arguments: { id: 'BND-T-1.1', status: 'cancelled' },
    });

    // The question names what is lost, rather than asking "are you sure?".
    expect(asked.toLowerCase()).toMatch(/abandon|history of intent/);
    // Declining is a normal outcome that says what did not happen.
    expect(text(result)).toMatch(/Not done|Nothing was changed/);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('creates an idea with the title and the description, in one call', async () => {
    const { client: api, calls } = fakeApi({
      '/api/projects/BND/ideas': { humanId: 'BND-IDEA-004', title: 'A scanner shortcut' },
    });
    const { client } = await connect(api);

    const result = await client.callTool({
      name: 'foreman_create',
      arguments: {
        kind: 'idea',
        project: 'BND',
        text: 'A scanner shortcut',
        body: 'One button that ingests whatever is on the glass.',
      },
    });

    const call = calls.find((c) => c.method === 'POST');
    expect(call?.path).toBe('/api/projects/BND/ideas');
    // `text` is the title and `body` is the description: one tool spelling for five kinds, and
    // the mapping is the thing that silently drops a field if it is wrong.
    expect(call?.body).toEqual({
      title: 'A scanner shortcut',
      body: 'One button that ingests whatever is on the glass.',
    });
    expect(text(result)).toContain('BND-IDEA-004');
  });

  it('sends an idea’s reason as `reason`, not as `blockedReason`', async () => {
    const { client: api, calls } = fakeApi({
      '/api/entities/BND-IDEA-004': { type: 'idea', entity: { status: 'new' } },
      '/api/projects/BND/ideas/BND-IDEA-004': { ok: true },
    });
    const { client } = await connect(api, { elicitation: () => ({ confirm: true }) });

    await client.callTool({
      name: 'foreman_set_status',
      arguments: { id: 'BND-IDEA-004', status: 'rejected', reason: 'Bindery is desktop-first.' },
    });

    // A task carries its reason as `blockedReason` and only while blocked. Sending an idea's the
    // same way would drop it on the floor — the server would take the rejection with no reason,
    // which is the one state this feature exists to prevent.
    const call = calls.find((c) => c.method === 'PATCH');
    expect(call?.body).toEqual({ status: 'rejected', reason: 'Bindery is desktop-first.' });
  });

  it('proceeds when confirmed', async () => {
    const { client: api, calls } = fakeApi({
      '/api/entities/BND-T-1.1': { type: 'task', entity: { status: 'in_progress' } },
      '/api/projects/BND/tasks/BND-T-1.1': { ok: true },
    });
    const { client } = await connect(api, { elicitation: () => ({ confirm: true }) });

    await client.callTool({
      name: 'foreman_set_status',
      arguments: { id: 'BND-T-1.1', status: 'cancelled' },
    });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
  });

  it('asks before a task moves backwards', async () => {
    const { client: api } = fakeApi({
      '/api/entities/BND-T-1.1': { type: 'task', entity: { status: 'done' } },
      '/api/projects/BND/tasks/BND-T-1.1': { ok: true },
    });
    let asked = '';
    const { client } = await connect(api, {
      elicitation: (message) => {
        asked = message;
        return { confirm: true };
      },
    });

    await client.callTool({
      name: 'foreman_set_status',
      arguments: { id: 'BND-T-1.1', status: 'todo' },
    });
    // A regression is the one status change worth stopping on.
    expect(asked).not.toBe('');
  });

  it('asks before unlinking, which loses a citation', async () => {
    const { client: api, calls } = fakeApi({ '/api/links': { ok: true } });
    let asked = '';
    const { client } = await connect(api, {
      elicitation: (message) => {
        asked = message;
        return 'decline';
      },
    });

    await client.callTool({
      name: 'foreman_link',
      arguments: { from: 'BND-T-1.1', to: 'BND-REQ-021', remove: true },
    });
    expect(asked).not.toBe('');
    expect(calls.some((c) => c.path === '/api/links')).toBe(false);
  });

  it('cannot be asked, and says so, when the client declares no elicitation', async () => {
    // A client with no elicitation capability is a real case — and a gated write must not
    // silently proceed just because nobody could be asked.
    const { client: api, calls } = fakeApi({
      '/api/entities/BND-T-1.1': { type: 'task', entity: { status: 'in_progress' } },
    });
    const { client } = await connect(api);

    const result = await client.callTool({
      name: 'foreman_set_status',
      arguments: { id: 'BND-T-1.1', status: 'cancelled' },
    });

    expect(result.isError ?? false, text(result)).toBe(true);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('does not ask before forward progress', async () => {
    const { client: api, calls } = fakeApi({
      '/api/entities/BND-T-1.1': { type: 'task', entity: { status: 'todo' } },
      '/api/projects/BND/tasks/BND-T-1.1': { ok: true },
    });
    let asked = false;
    const { client } = await connect(api, {
      elicitation: () => {
        asked = true;
        return { confirm: true };
      },
    });

    await client.callTool({
      name: 'foreman_set_status',
      arguments: { id: 'BND-T-1.1', status: 'in_progress' },
    });

    // A confirmation on every motion of working is how confirmations stop being read.
    expect(asked).toBe(false);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
  });
});

describe('resources over the protocol (T-4.9, FRM-REQ-087)', () => {
  it('lists documents and sections as URIs', async () => {
    const { client: api } = fakeApi({
      '/api/resources': {
        items: [
          {
            uri: 'foreman://BND/architecture',
            name: 'BND — Architecture',
            description: 'architecture, 6 sections',
            mimeType: 'text/markdown',
          },
          {
            uri: 'foreman://BND/architecture#deployment',
            name: 'BND — Architecture — Deployment',
            description: 'Behind a Cloudflare Tunnel.',
            mimeType: 'text/markdown',
          },
        ],
      },
    });
    const { client } = await connect(api);

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('foreman://BND/architecture#deployment');
  });

  it('reads one section, through the template, and returns markdown', async () => {
    const { client: api, calls } = fakeApi({
      '/api/projects/BND/documents/at/architecture/sections/deployment': {
        markdown: '## Deployment\n\nBehind a Cloudflare Tunnel, with no host ports.',
      },
    });
    const { client } = await connect(api);

    const result = await client.readResource({ uri: 'foreman://BND/architecture#deployment' });

    expect(calls[0]?.path).toBe('/api/projects/BND/documents/at/architecture/sections/deployment');
    expect((result.contents[0] as { text?: string }).text).toContain('no host ports');
    expect(result.contents[0]?.mimeType).toBe('text/markdown');
  });

  it('reads a whole document when the URI has no fragment', async () => {
    const { client: api, calls } = fakeApi({
      '/api/projects/BND/documents/at/architecture': { markdown: '# Architecture' },
    });
    const { client } = await connect(api);

    await client.readResource({ uri: 'foreman://BND/architecture' });
    expect(calls[0]?.path).toBe('/api/projects/BND/documents/at/architecture');
  });

  it('answers a URI that resolves to nothing with the message, not a crash', async () => {
    const failing: ForemanClient = {
      get: () =>
        Promise.reject(
          Object.assign(new Error('BND has no document at "nonsense" — it has architecture'), {
            status: 404,
          }),
        ),
      post: () => Promise.reject(new Error('unused')),
      patch: () => Promise.reject(new Error('unused')),
      del: () => Promise.reject(new Error('unused')),
    };
    const { client } = await connect(failing);

    const result = await client.readResource({ uri: 'foreman://BND/nonsense' });
    // A resource read has no `isError`, so the message is the content — and it names what exists,
    // which is what makes the next call the right one.
    expect((result.contents[0] as { text?: string }).text).toContain('it has architecture');
  });
});

describe('what the MCP surface deliberately cannot do', () => {
  it('can delete an idea, and nothing else', async () => {
    const { client } = await connect(fakeApi().client);
    const { tools } = await client.listTools();

    // This test used to assert that no delete verb existed at all (ADR-002), on the reasoning
    // that the one surface able to delete should be the one where a person can see what they are
    // about to lose. That reasoning is about *citations*, so FRM-ADR-014 narrows the absence to
    // where it earns its keep rather than reversing it: an idea is cited by nothing, and a
    // backlog nobody can prune is a backlog nobody reads.
    const names = tools.map((t) => t.name);
    expect(names).toContain('foreman_delete');
    // Exactly one. A second spelling is how a narrowed verb quietly gets its scope back.
    expect(names.filter((n) => /delete|destroy|purge|remove/i.test(n))).toEqual(['foreman_delete']);

    const remove = WRITE_TOOLS.find((t) => t.name === 'foreman_delete');
    expect(remove?.inputSchema.safeParse({ id: 'BND-IDEA-004' }).success).toBe(true);
    // The narrowing is the schema's, not a branch inside `run` — so it holds for anything that
    // parses this input, and the model is told why rather than getting a generic type error.
    for (const cited of ['BND-REQ-012', 'BND-T-004', 'BND-P-3', 'BND-CR-037']) {
      const result = remove?.inputSchema.safeParse({ id: cited });
      expect(result?.success, cited).toBe(false);
      expect(result?.error?.issues[0]?.message, cited).toContain('console');
    }
  });

  it('gates that delete unconditionally, unlike every other write', async () => {
    const remove = WRITE_TOOLS.find((t) => t.name === 'foreman_delete');
    const decision = await remove?.gate({} as never, { id: 'BND-IDEA-004' });

    expect(decision?.gated).toBe(true);
    expect(decision?.because).toContain('citation');
  });

  it('exposes no prompt, and no sampling', async () => {
    const { client } = await connect(fakeApi().client);
    // Foreman never calls a model (FRM-REQ-013). A sampling capability would be the server asking
    // the client to run an inference on its behalf — the same thing by another route.
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
    await expect(client.listPrompts()).rejects.toThrow();
  });
});
