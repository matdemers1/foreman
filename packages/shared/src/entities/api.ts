import { z } from 'zod';
import { HumanId, ProjectCode } from '../ids.js';

/**
 * The request shapes the API and the MCP shim **both** use.
 *
 * This is FRM-REQ-003 at its most load-bearing: an MCP tool's input schema is generated from the
 * schema declared here, and the Express route validates against the same one. A contract test
 * asserts the generated JSON Schema matches, so the two surfaces cannot drift — which is the whole
 * claim behind calling them equal peers rather than an API with a wrapper.
 */

export const SEARCHABLE_TYPES = [
  'requirement',
  'task',
  'adr',
  'finding',
  'document_section',
  'term',
  'phase',
  'decision',
  'risk',
] as const;

export const SearchableType = z.enum(SEARCHABLE_TYPES);
export type SearchableType = z.infer<typeof SearchableType>;

/** `foreman_brief` / `GET /api/brief/:code`. */
export const BriefInput = z.object({
  project: ProjectCode.describe('The project code, e.g. BND'),
});
export type BriefInput = z.infer<typeof BriefInput>;

/** `foreman_portfolio` / `GET /api/portfolio`. No arguments: it is the whole picture or nothing. */
export const PortfolioInput = z.object({});
export type PortfolioInput = z.infer<typeof PortfolioInput>;

/** `foreman_search` / `GET /api/search`. */
export const SearchInput = z.object({
  q: z.string().min(1).max(200).describe('What to look for; an exact human ID resolves first'),
  types: z
    .array(SearchableType)
    .optional()
    .describe('Narrow to these kinds of thing'),
  project: ProjectCode.optional().describe('Narrow to one project'),
  limit: z.number().int().min(1).max(100).default(30),
});
export type SearchInput = z.infer<typeof SearchInput>;

/** `foreman_get` / `GET /api/entities/:humanId`. */
export const GetInput = z.object({
  id: HumanId.describe('A project-prefixed human ID, e.g. BND-REQ-021'),
  backlinks: z
    .boolean()
    .default(true)
    .describe('Include what cites this entity'),
});
export type GetInput = z.infer<typeof GetInput>;

/**
 * Cache metadata on a listing. The client is told how long an answer stays good for and what it is
 * scoped to, so it need not re-ask for a portfolio that has not changed.
 */
export const CacheMeta = z.object({
  ttlMs: z.number().int().nonnegative(),
  cacheScope: z.enum(['project', 'global']),
});
export type CacheMeta = z.infer<typeof CacheMeta>;

/** How long each answer stays useful. Short, because the point of Foreman is that it is current. */
export const CACHE = {
  brief: { ttlMs: 30_000, cacheScope: 'project' },
  portfolio: { ttlMs: 60_000, cacheScope: 'global' },
  search: { ttlMs: 15_000, cacheScope: 'global' },
  get: { ttlMs: 30_000, cacheScope: 'project' },
} as const satisfies Record<string, CacheMeta>;
