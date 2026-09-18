import { BriefInput, CACHE, GetInput, PortfolioInput, SearchInput } from '@foreman/shared';
import { z } from 'zod';
import type { ForemanClient } from '../client.js';

/**
 * The read tools (T-1.9). Writes arrive in Phase 2.
 *
 * Every input schema is **the one declared in `packages/shared`** — not a copy of it. That is what
 * makes the console and this shim equal peers rather than an API and a wrapper that drifts from it,
 * and a contract test asserts the generated JSON Schema still matches.
 *
 * Descriptions are deliberately terse. Tool definitions are sent on every single turn, so prose
 * here is a tax paid forever; the research this was sized against says an overlong definition set
 * is the specific thing that kills an MCP server's usefulness.
 */

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  /** Advertised so a client need not re-ask for an answer that has not gone stale. */
  readonly cache: { readonly ttlMs: number; readonly cacheScope: 'project' | 'global' };
  /**
   * Always returns a promise, and never throws synchronously — including on invalid input. A
   * caller that has to handle both a throw and a rejection will eventually handle only one.
   */
  run(client: ForemanClient, input: unknown): Promise<unknown>;
}

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'foreman_brief',
    title: 'Project brief',
    description:
      'Where a project stands: active phase, next unblocked tasks, blocked work and why, open ' +
      'criticals, CI, and drift. Call this first.',
    inputSchema: BriefInput,
    cache: CACHE.brief,
    run: async (client, input) => {
      const { project } = BriefInput.parse(input);
      return client.get(`/api/brief/${project}`);
    },
  },
  {
    name: 'foreman_portfolio',
    title: 'Portfolio',
    description: 'One row per project: lifecycle, active phase, task counts, criticals, CI, drift.',
    inputSchema: PortfolioInput,
    cache: CACHE.portfolio,
    run: async (client) => client.get('/api/portfolio'),
  },
  {
    name: 'foreman_search',
    title: 'Search',
    description:
      'Typed search across requirements, tasks, ADRs, findings, decisions, risks, terms, phases ' +
      'and document sections. An exact human ID resolves to that entity first.',
    inputSchema: SearchInput,
    cache: CACHE.search,
    run: async (client, input) => {
      const args = SearchInput.parse(input);
      return client.get('/api/search', {
        q: args.q,
        types: args.types,
        project: args.project,
        limit: args.limit,
      });
    },
  },
  {
    name: 'foreman_get',
    title: 'Get by ID',
    description: 'One entity by human ID (BND-REQ-021), with what cites it.',
    inputSchema: GetInput,
    cache: CACHE.get,
    run: async (client, input) => {
      const args = GetInput.parse(input);
      return client.get(`/api/entities/${args.id}`, { backlinks: args.backlinks });
    },
  },
];

/**
 * The ceiling, asserted by a contract test. Twelve is not arbitrary: past roughly that many, the
 * definitions cost more context than the answers are worth, and the model starts choosing badly
 * between tools that sound alike.
 */
export const MAX_TOOLS = 12;

/**
 * The token budget for the whole definition set. Four characters per token is the usual
 * approximation for English; the number is crude on purpose, because the failure it guards against
 * is a doubling, not a rounding.
 */
export const TOOL_DEFINITION_TOKEN_BUDGET = 1200;

export function toolDefinitionTokens(definitions: readonly ToolDefinition[] = TOOLS): number {
  const payload = definitions.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema, { io: 'input' }),
  }));
  return Math.ceil(JSON.stringify(payload).length / 4);
}
