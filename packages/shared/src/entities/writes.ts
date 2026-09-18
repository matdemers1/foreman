import { z } from 'zod';
import { Priority, Size } from '../enums.js';
import { HumanId, ProjectCode } from '../ids.js';

/**
 * The write surface, shared by the API and the MCP shim (FRM-REQ-089, FRM-REQ-090, FRM-REQ-091).
 *
 * The gate rules live here rather than in the shim, because "which changes need asking about" is a
 * property of the change, not of the surface making it. A console that skipped a confirmation the
 * shim insists on would be the same product answering the same question two ways.
 */

export const CreatableKind = z.enum(['requirement', 'task', 'phase']);
export type CreatableKind = z.infer<typeof CreatableKind>;

export const CreateInput = z.object({
  project: ProjectCode.describe('The project code, e.g. BND'),
  kind: CreatableKind,
  /** What the entity says. A requirement's statement, a task's or phase's title. */
  text: z.string().min(1).max(4000).describe('The statement, title or name'),
  phase: HumanId.optional().describe('The phase to file it under'),
  priority: Priority.optional(),
  size: Size.optional(),
  doneWhen: z.string().max(2000).optional(),
  /** Phase only. Decimal is legal: a Phase 8.5 exists. */
  number: z.number().optional(),
  /** Requirements this task satisfies. */
  satisfies: z.array(HumanId).optional(),
});
export type CreateInput = z.infer<typeof CreateInput>;

export const UpdateInput = z.object({
  id: HumanId.describe('The entity to change, e.g. BND-T-0.3'),
  text: z.string().min(1).max(4000).optional().describe('Replaces the statement, title or name'),
  priority: Priority.optional(),
  size: Size.optional(),
  doneWhen: z.string().max(2000).optional(),
  phase: HumanId.nullish().describe('Move to this phase, or null for the backlog'),
});
export type UpdateInput = z.infer<typeof UpdateInput>;

export const SetStatusInput = z.object({
  id: HumanId,
  status: z.string().min(1).max(40).describe('The new status for this kind of entity'),
  /** Required when moving a task to `blocked`: a blocked task must say what is blocking it. */
  reason: z.string().max(1000).optional(),
});
export type SetStatusInput = z.infer<typeof SetStatusInput>;

export const LinkInput = z.object({
  from: HumanId,
  to: HumanId,
  kind: z.enum(['satisfies', 'violates', 'relates', 'supersedes', 'extends']).default('relates'),
  /** Remove the link instead of adding it. Always gated: unlinking loses a citation. */
  remove: z.boolean().default(false),
});
export type LinkInput = z.infer<typeof LinkInput>;

/**
 * `foreman_attribute` — Claude saying what a commit was for (T-5.9, FRM-REQ-109).
 *
 * This is **signal 1**, and the only one that is not an inference. Foreman's other two signals read
 * a commit message or a file list and guess; this is the one party that was actually there saying
 * what it did. So a declaration arrives confirmed, where a proposal does not.
 */
export const AttributeInput = z.object({
  /** The commit. A short SHA is fine — that is what anybody has to hand. */
  sha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i, 'a commit SHA, seven characters or more'),
  task: HumanId.describe('The task this commit was work on, e.g. BND-T-13.9'),
  /** Withdraw an attribution instead of asserting one. Gated: it removes a recorded fact. */
  remove: z.boolean().default(false),
});
export type AttributeInput = z.infer<typeof AttributeInput>;

// ─── The gate ──────────────────────────────────────────────────────────────

/**
 * Task statuses in the order work moves through them. Anything that goes **backwards** in this list
 * is a regression, and a regression is asked about first.
 */
const TASK_PROGRESSION: readonly string[] = ['todo', 'in_progress', 'done'];

export interface GateDecision {
  readonly gated: boolean;
  /** Why, phrased for the person being asked. Present whenever `gated` is true. */
  readonly because?: string;
}

const ALLOWED = { gated: false } as const;

/**
 * Does this change need asking about first?
 *
 * **Forward progress does not.** Marking a task done, logging a decision, filing a finding — these
 * are the motions of working, and a confirmation on each is how a confirmation stops being read.
 * What is gated is the small set of changes that lose something: a delete, a regression, an
 * abandonment, a `Won't`, an unlink.
 */
export function gateForStatus(
  entityType: string,
  from: string | null,
  to: string,
): GateDecision {
  if (to === 'cancelled') {
    return { gated: true, because: 'Cancelling abandons the work and its history of intent.' };
  }

  if (entityType === 'task') {
    const fromIndex = from === null ? -1 : TASK_PROGRESSION.indexOf(from);
    const toIndex = TASK_PROGRESSION.indexOf(to);
    if (fromIndex > -1 && toIndex > -1 && toIndex < fromIndex) {
      return {
        gated: true,
        because: `Moving a task from ${from ?? 'unknown'} back to ${to} undoes recorded progress.`,
      };
    }
  }

  if (entityType === 'phase' && to === 'complete') {
    return {
      gated: true,
      because: 'Completing a phase runs its exit gate and closes it as the answer to "where are we".',
    };
  }

  return ALLOWED;
}

export function gateForPriority(to: string): GateDecision {
  if (to === 'W') {
    return {
      gated: true,
      because: "Setting a requirement to Won't takes it out of every coverage calculation.",
    };
  }
  return ALLOWED;
}

export function gateForDelete(): GateDecision {
  return {
    gated: true,
    because: 'Deleting hides the entity and every citation of it, though it can be undone.',
  };
}

export function gateForLink(remove: boolean): GateDecision {
  return remove
    ? { gated: true, because: 'Unlinking removes a citation, which is how coverage is computed.' }
    : ALLOWED;
}

/** Every gated reason, for the contract test that keeps the list honest. */
export const GATED_OPERATIONS = [
  'delete',
  'status:cancelled',
  'status:task-backwards',
  'status:phase-complete',
  'priority:W',
  'link:remove',
] as const;

/**
 * Withdrawing an attribution is asked about; asserting one is not.
 *
 * Declaring what a commit was for is forward progress — the motion of working, and gating it is
 * how a confirmation stops being read. Withdrawing one removes something a person may have relied
 * on when they looked at coverage.
 */
export function gateForAttribute(remove: boolean): GateDecision {
  return remove
    ? {
        gated: true,
        because:
          'Withdrawing an attribution removes a recorded link between a commit and the work it ' +
          'was for. Coverage and release notes read that link.',
      }
    : { gated: false };
}
