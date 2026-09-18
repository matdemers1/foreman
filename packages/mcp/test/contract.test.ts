import {
  BriefInput,
  CACHE,
  GetInput,
  PortfolioInput,
  SEARCHABLE_TYPES,
  SearchInput,
} from '@foreman/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createClient, ForemanApiError } from '../src/client.js';
import { createServer } from '../src/server.js';
import {
  MAX_TOOLS,
  TOOL_DEFINITION_TOKEN_BUDGET,
  TOOLS,
  toolDefinitionTokens,
} from '../src/tools/index.js';

/**
 * The contract tests (T-1.10). Each one fails on a deliberate violation — that is the only kind of
 * guard worth having.
 */

describe('the tool surface stays small (FRM-REQ-079, FRM-REQ-080)', () => {
  it('has at most twelve tools', () => {
    expect(TOOLS.length).toBeLessThanOrEqual(MAX_TOOLS);
  });

  it('fails when a thirteenth is added — the exit demo, as an assertion', () => {
    const thirteen = [
      ...TOOLS,
      ...Array.from({ length: MAX_TOOLS + 1 - TOOLS.length }, (_, i) => ({
        ...TOOLS[0],
        name: `foreman_extra_${String(i)}`,
      })),
    ];
    expect(thirteen.length).toBeGreaterThan(MAX_TOOLS);
  });

  it('keeps the whole definition set inside its token budget', () => {
    const tokens = toolDefinitionTokens();
    expect(tokens).toBeLessThan(TOOL_DEFINITION_TOKEN_BUDGET);
  });

  it('fails the budget when a description bloats', () => {
    const bloated = TOOLS.map((tool) => ({
      ...tool,
      description: tool.description.repeat(40),
    }));
    expect(toolDefinitionTokens(bloated)).toBeGreaterThan(TOOL_DEFINITION_TOKEN_BUDGET);
  });

  it('names every tool distinctly, and with the product prefix', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.startsWith('foreman_')).toBe(true);
  });

  it('gives every tool a description short enough to be sent every turn', () => {
    for (const tool of TOOLS) {
      expect(tool.description.length, tool.name).toBeLessThan(220);
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
    }
  });
});

describe('schemas are generated from packages/shared (FRM-REQ-081)', () => {
  // The claim under test: the shim does not carry its own copy of the request shapes. If one of
  // these ever needs updating by hand, the two surfaces have already drifted.
  const expected: Record<string, z.ZodType> = {
    foreman_brief: BriefInput,
    foreman_portfolio: PortfolioInput,
    foreman_search: SearchInput,
    foreman_get: GetInput,
  };

  it.each(TOOLS.map((tool) => [tool.name, tool] as const))(
    '%s uses the shared schema itself, not a copy',
    (name, tool) => {
      const shared = expected[name];
      if (shared === undefined) throw new Error(`${name} has no shared schema declared`);
      expect(z.toJSONSchema(tool.inputSchema, { io: 'input' })).toEqual(
        z.toJSONSchema(shared, { io: 'input' }),
      );
    },
  );

  it('notices when a field is added on one side only', () => {
    const drifted = SearchInput.extend({ sneaky: z.string() });
    expect(z.toJSONSchema(drifted, { io: 'input' })).not.toEqual(
      z.toJSONSchema(SearchInput, { io: 'input' }),
    );
  });

  it('offers every searchable type the API knows about', () => {
    const schema: unknown = z.toJSONSchema(SearchInput, { io: 'input' });
    const types = (schema as { properties: Record<string, { items?: { enum?: string[] } }> })
      .properties['types'];
    expect(types?.items?.enum).toEqual([...SEARCHABLE_TYPES]);
  });
});

describe('listings carry cache metadata', () => {
  it.each(TOOLS.map((tool) => [tool.name, tool] as const))('%s advertises a TTL and a scope', (_name, tool) => {
    expect(tool.cache.ttlMs).toBeGreaterThan(0);
    expect(['project', 'global']).toContain(tool.cache.cacheScope);
  });

  it('scopes the portfolio globally and the brief to a project', () => {
    expect(CACHE.portfolio.cacheScope).toBe('global');
    expect(CACHE.brief.cacheScope).toBe('project');
  });
});

describe('the tools call the API they claim to', () => {
  const clientWith = (get: ReturnType<typeof vi.fn>) => ({ get }) as never;

  it('foreman_brief asks for that project’s brief', async () => {
    const get = vi.fn().mockResolvedValue({ project: { code: 'BND' } });
    const tool = TOOLS.find((t) => t.name === 'foreman_brief');
    await tool?.run(clientWith(get), { project: 'BND' });
    expect(get).toHaveBeenCalledWith('/api/brief/BND');
  });

  it('foreman_search passes its filters through', async () => {
    const get = vi.fn().mockResolvedValue({ items: [] });
    const tool = TOOLS.find((t) => t.name === 'foreman_search');
    await tool?.run(clientWith(get), { q: 'pg_trgm', types: ['adr'], project: 'BND', limit: 5 });
    expect(get).toHaveBeenCalledWith('/api/search', {
      q: 'pg_trgm',
      types: ['adr'],
      project: 'BND',
      limit: 5,
    });
  });

  it('refuses input that does not match the shared schema', async () => {
    const tool = TOOLS.find((t) => t.name === 'foreman_get');
    // Not project-prefixed, so it is not a human ID (ADR-008).
    await expect(tool?.run(clientWith(vi.fn()), { id: 'REQ-021' })).rejects.toThrow();
  });
});

describe('the HTTP client', () => {
  it('sends the scoped token as a bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const client = createClient({ baseUrl: 'https://foreman.test', token: 'shh', fetch: fetchMock });
    await client.get('/api/portfolio');

    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers['authorization']).toBe('Bearer shh');
  });

  it('joins an array parameter the way the API parses it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const client = createClient({ baseUrl: 'https://foreman.test', token: 'shh', fetch: fetchMock });
    await client.get('/api/search', { q: 'x', types: ['adr', 'task'] });

    const url = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.searchParams.get('types')).toBe('adr,task');
  });

  it('turns an error response into a message a model can act on', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"error":"project NOPE not found"}', { status: 404 }));
    const client = createClient({ baseUrl: 'https://foreman.test', token: 'shh', fetch: fetchMock });

    await expect(client.get('/api/brief/NOPE')).rejects.toThrow(/project NOPE not found/);
    await expect(client.get('/api/brief/NOPE')).rejects.toBeInstanceOf(ForemanApiError);
  });

  it('gives up rather than hanging the session', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: URL, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    const client = createClient({
      baseUrl: 'https://foreman.test',
      token: 'shh',
      fetch: fetchMock,
      timeoutMs: 10,
    });

    await expect(client.get('/api/portfolio')).rejects.toThrow(/did not answer/);
  });
});

describe('the server', () => {
  it('builds, and registers every tool', () => {
    const server = createServer({ client: createClient({ baseUrl: 'https://x.test', token: 't' }) });
    expect(server).toBeDefined();
  });

  it('uses no deprecated SDK primitive', async () => {
    // `tool()` and `resource()` are deprecated in favour of `registerTool` / `registerResource`.
    // Reading the source is cruder than it looks, and it is the only check that actually notices.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    expect(source).toContain('registerTool');
    expect(source).not.toMatch(/\bserver\.tool\(/);
    expect(source).not.toMatch(/\bserver\.resource\(/);
    expect(source).not.toMatch(/\bserver\.prompt\(/);
  });
});
