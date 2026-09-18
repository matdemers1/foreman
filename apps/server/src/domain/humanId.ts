import { formatHumanId, HUMAN_ID_TYPE, parseHumanId } from '@foreman/shared';
import type { TransactionClient } from './audit.js';

/**
 * Allocating human IDs (FRM-REQ-044, FRM-REQ-045, ADR-008).
 *
 * Two properties carry the weight:
 *
 * 1. **An ID is never reused.** The next sequence comes from a counter on the project, not from
 *    `count(*)` — deleting `BND-REQ-007` must not hand its number to the next requirement, because
 *    every document body that cites `BND-REQ-007` would then point at something else.
 * 2. **An ID is immutable once assigned.** There is deliberately no function here that changes one.
 *    Renumbering breaks every citation in every document body, and the only safe rename is none.
 */

export type HumanIdKind = keyof typeof HUMAN_ID_TYPE;

/**
 * Take the next sequence for a kind, inside the caller's transaction. The update and the read are
 * one statement, so two concurrent creates cannot take the same number.
 */
export async function nextSequence(
  tx: TransactionClient,
  projectId: string,
  kind: HumanIdKind,
): Promise<number> {
  const type = HUMAN_ID_TYPE[kind];
  const rows = await tx.$queryRaw<{ id_counters: Record<string, number> }[]>`
    update project
    set id_counters = jsonb_set(
      id_counters,
      array[${type}],
      to_jsonb(coalesce((id_counters ->> ${type})::int, 0) + 1),
      true
    )
    where id = ${projectId}::uuid
    returning id_counters
  `;

  const counters = rows[0]?.id_counters;
  const next = counters?.[type];
  if (next === undefined) throw new Error(`project ${projectId} not found while allocating an ID`);
  return next;
}

/** Allocate the next human ID for a kind — `BND-REQ-008`. */
export async function allocate(
  tx: TransactionClient,
  project: { id: string; code: string },
  kind: HumanIdKind,
): Promise<{ humanId: string; seq: number }> {
  const seq = await nextSequence(tx, project.id, kind);
  return { humanId: formatHumanId(project.code, HUMAN_ID_TYPE[kind], seq), seq };
}

/**
 * A task's ID carries its phase — `BND-T-0.3` — so it is not drawn from the counter. The position
 * within the phase is what makes it unique.
 */
export function taskHumanId(code: string, phaseNumber: number | string, position: number): string {
  return `${code}-${HUMAN_ID_TYPE.task}-${String(phaseNumber)}.${String(position)}`;
}

/** A phase's ID is its number: `BND-P-8.5`. */
export function phaseHumanId(code: string, phaseNumber: number | string): string {
  return `${code}-${HUMAN_ID_TYPE.phase}-${String(phaseNumber)}`;
}

/**
 * Confirm a human ID belongs to the project it is being used in. A citation that resolves to
 * another project's entity is not a lookup failure, it is a wrong answer.
 */
export function belongsTo(humanId: string, projectCode: string): boolean {
  return parseHumanId(humanId)?.code === projectCode;
}

/** Thrown when something tries to change an ID. There is no code path that catches and proceeds. */
export class ImmutableHumanIdError extends Error {
  constructor(readonly humanId: string) {
    super(
      `${humanId} cannot be renumbered: every citation of it, in every document body, would then ` +
        'point at something else',
    );
    this.name = 'ImmutableHumanIdError';
  }
}

/**
 * Guard an update. Called by every write path that accepts a body which could carry a `humanId`.
 */
export function refuseIdChange(current: string, incoming: unknown): void {
  if (incoming === undefined || incoming === null) return;
  if (typeof incoming === 'string' && incoming === current) return;
  throw new ImmutableHumanIdError(current);
}
