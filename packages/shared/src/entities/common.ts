import { z } from 'zod';
import { HumanId } from '../ids.js';

/**
 * Pieces every entity shares.
 *
 * `packages/shared` is the single source of truth (FRM-REQ-003): the API validates against these
 * schemas, the console's types are inferred from them, and the MCP tool schemas are **generated**
 * from them. A field added here cannot silently miss one of the three surfaces.
 */

export const Uuid = z.uuid();
export type Uuid = z.infer<typeof Uuid>;

/** An ISO-8601 instant. Dates cross the wire as strings, and are parsed once, at the edge. */
export const Instant = z.iso.datetime({ offset: true });
export type Instant = z.infer<typeof Instant>;

export const Timestamps = z.object({
  createdAt: Instant,
  updatedAt: Instant,
  /** Non-null means soft-deleted. Deletion is always soft — undo depends on it. */
  deletedAt: Instant.nullable(),
});

/** What every entity carries once it has been stored. */
export const Identified = z.object({
  id: Uuid,
  humanId: HumanId,
});

/**
 * Paging. **No route returns an unbounded list** (FRM-REQ-092): the corpus has 439 requirements
 * today, and an endpoint that returns everything is one that works until it does not.
 */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

export function pageOf(item: z.ZodType) {
  return z.object({
    items: z.array(item),
    /** Absent when this is the last page. Opaque: callers pass it back, they do not build it. */
    nextCursor: z.string().nullable(),
    /** The total, when it is cheap to know. Null rather than a guess. */
    total: z.number().int().nonnegative().nullable(),
  });
}

/**
 * The error shape every route returns. One shape, so a client never has to guess which it got.
 */
export const ApiProblem = z.object({
  error: z.string(),
  /** Per-field detail for a validation failure. */
  fields: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ApiProblem = z.infer<typeof ApiProblem>;

/**
 * A guard, not a convenience: **no entity may carry a time estimate** (FRM-REQ-041). Sizes are
 * T-shirts and ordering is by dependency. A field named like this one is how "no estimates"
 * quietly becomes "estimates, but in a column nobody named".
 */
export const FORBIDDEN_ESTIMATE_FIELDS = [
  'estimate',
  'estimatedHours',
  'estimated_hours',
  'estimateDays',
  'estimate_days',
  'hours',
  'days',
  'duration',
  'storyPoints',
  'story_points',
  'points',
  'velocity',
  'timeSpent',
  'time_spent',
  'dueDate',
  'due_date',
  'deadline',
  'sprint',
] as const;
